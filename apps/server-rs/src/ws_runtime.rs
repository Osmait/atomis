//! /ws/runtime handling mirrored from index.ts#handleRuntime: one socket per
//! session, message validation, document-store operations, run dispatch and
//! session teardown on close.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};

use crate::packs;
use crate::protocol::{
    Language, RunState, RuntimeClientMessage, ServerEvent, MAX_RUNTIME_MESSAGE_BYTES,
};
use crate::scheduler::RunScheduler;
use crate::session::{Session, SessionSettings, Snapshot};
use crate::state::AppState;

fn to_json(event: &ServerEvent) -> String {
    serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string())
}

fn run_disabled_message(language: Language) -> String {
    if language == Language::Rust {
        "Run is disabled: Rust 1.75+ is required. Run pnpm run doctor.".to_string()
    } else {
        "Run is disabled: Zig 0.16.x is required. Run pnpm run doctor.".to_string()
    }
}

/// How long a session outlives its socket, so a sleeping tablet or a network
/// blip can pick it back up instead of losing the workspace.
const RECONNECT_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

pub async fn handle_runtime(state: Arc<AppState>, session: Arc<Session>, socket: WebSocket) {
    if session
        .runtime_connected
        .swap(true, Ordering::SeqCst)
    {
        let mut socket = socket;
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1008,
                reason: "A runtime connection already exists for this session".into(),
            })))
            .await;
        return;
    }

    let generation = session.attach_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (outbox_tx, mut outbox_rx) = tokio::sync::mpsc::unbounded_channel::<ServerEvent>();
    let scheduler = RunScheduler::new(Arc::clone(&session), outbox_tx.clone());
    state
        .lsp_registry
        .register_session(&session.id)
        .await;

    let (mut sink, mut stream) = {
        use futures_util::StreamExt;
        socket.split()
    };
    let writer = tokio::spawn(async move {
        use futures_util::SinkExt;
        while let Some(event) = outbox_rx.recv().await {
            if sink
                .send(Message::Text(to_json(&event).into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    // Preferences are not session state, so they arrive out of band: every
    // open socket gets the same fan-out, and the tab that made the change
    // recognises its own values and ignores the echo.
    let preferences = {
        let mut changes = state.preference_changes.subscribe();
        let outbox_tx = outbox_tx.clone();
        tokio::spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(patch) => {
                        if outbox_tx
                            .send(ServerEvent::PreferencesChanged { preferences: patch })
                            .is_err()
                        {
                            break;
                        }
                    }
                    // Lagged: this socket missed a change it will pick up on
                    // the next one, or on its next load. Keep listening.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    };

    // Initial run (or the degraded notice) exactly like the Node server.
    if session
        .support
        .get(&session.language)
        .is_some_and(|s| s.run)
    {
        let version = session.current().await.version;
        scheduler.run(version, Some(session.language)).await;
    } else {
        let message = if session.language == Language::Rust {
            "Rust 1.75+ is unavailable; Run is disabled. Run pnpm run doctor."
        } else {
            "Zig 0.16.x is unavailable; Run is disabled. Run pnpm run doctor."
        };
        let _ = outbox_tx.send(ServerEvent::ServerError {
            recoverable: true,
            message: message.to_string(),
            details: None,
        });
    }

    use futures_util::StreamExt;
    while let Some(message) = stream.next().await {
        let Ok(message) = message else { break };
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(_) => break,
            Message::Close(_) => break,
            _ => continue,
        };
        if text.len() > MAX_RUNTIME_MESSAGE_BYTES {
            break;
        }
        let parsed: Result<RuntimeClientMessage, _> = serde_json::from_str(&text);
        let message = match parsed {
            Ok(message) => message,
            Err(error) => {
                let recoverable = ServerEvent::ServerError {
                    recoverable: true,
                    message: if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                        "Invalid JSON runtime message".to_string()
                    } else {
                        "Invalid runtime message".to_string()
                    },
                    details: Some(error.to_string()),
                };
                let _ = outbox_tx.send(recoverable);
                continue;
            }
        };
        if let Err(details) = message.validate() {
            let _ = outbox_tx.send(ServerEvent::ServerError {
                recoverable: true,
                message: "Invalid runtime message".to_string(),
                details: Some(details),
            });
            continue;
        }
        if message.session_id() != session.id {
            break;
        }
        if let Err(error) = handle_message(&session, &scheduler, &outbox_tx, message).await {
            let _ = outbox_tx.send(ServerEvent::ServerError {
                recoverable: true,
                message: error,
                details: None,
            });
        }
    }

    scheduler.close().await;
    preferences.abort();
    writer.abort();
    session.runtime_connected.store(false, Ordering::SeqCst);
    state.lsp_registry.close_session(&session.id).await;

    // A scratch session's directory is deleted with it, so a dropped
    // connection used to cost the user their files — and a tablet drops one
    // every time its screen locks. Wait, and only tear down if nothing has
    // attached since: `attach_generation` still reading what this connection
    // saw means nobody came back for it.
    let state_for_destroy = Arc::clone(&state);
    let session_for_destroy = Arc::clone(&session);
    let session_id = session.id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RECONNECT_GRACE).await;
        if session_for_destroy
            .attach_generation
            .load(Ordering::SeqCst)
            != generation
        {
            return;
        }
        state_for_destroy.sessions.destroy(&session_id).await;
    });
}

/// Reads and reports what the workspace declares. Cheap enough to run
/// after every change instead of caching it.
async fn send_deps_catalog(
    session: &Arc<Session>,
    outbox: &tokio::sync::mpsc::UnboundedSender<ServerEvent>,
) {
    let language = session.language;
    let Some(support) = crate::deps::support(language) else {
        let _ = outbox.send(ServerEvent::DepsCatalog {
            language,
            supported: false,
            manifest: None,
            input_hint: None,
            runs_untrusted_code: false,
            dependencies: Vec::new(),
        });
        return;
    };
    let text = tokio::fs::read_to_string(session.root.join(support.manifest))
        .await
        .unwrap_or_default();
    let _ = outbox.send(ServerEvent::DepsCatalog {
        language,
        supported: true,
        manifest: Some(support.manifest.to_string()),
        input_hint: Some(support.input_hint.to_string()),
        runs_untrusted_code: support.runs_untrusted_code,
        dependencies: crate::deps::parse_manifest(language, &text),
    });
}

/// Runs one dependency command. Installing is the only step in Atomis that
/// may reach the network, and only outbound HTTPS: the sandbox policy is
/// widened for this process alone, never for builds or user code.
async fn run_deps_command(
    session: &Arc<Session>,
    outbox: &tokio::sync::mpsc::UnboundedSender<ServerEvent>,
    name: String,
    installing: bool,
) -> Result<(), String> {
    let language = session.language;
    let support = crate::deps::support(language).ok_or("This language has no package manager")?;
    let settings = session.settings.lock().await.clone();
    let base = session.sandbox(&settings);
    let sandbox = match (&base, installing) {
        (Some(policy), true) => Some(std::sync::Arc::new(crate::sandbox::with_fetch_network(
            policy,
        ))),
        (policy, _) => policy.clone(),
    };

    // Removing where the toolchain has no command for it (zig) is a
    // manifest edit, not a process.
    if !installing && support.remove.is_none() {
        let path = session.root.join(support.manifest);
        let text = tokio::fs::read_to_string(&path)
            .await
            .map_err(|error| error.to_string())?;
        let state = match crate::deps::manifest_without(language, &text, &name) {
            Some(updated) => {
                tokio::fs::write(&path, updated)
                    .await
                    .map_err(|error| error.to_string())?;
                crate::protocol::DepsState::Idle
            }
            None => crate::protocol::DepsState::Failed,
        };
        send_deps_catalog(session, outbox).await;
        let _ = outbox.send(ServerEvent::DepsState {
            state,
            name: Some(name),
            error: (state == crate::protocol::DepsState::Failed)
                .then(|| "not found in the manifest".to_string()),
        });
        return Ok(());
    }

    let template = if installing {
        support.add
    } else {
        support.remove.unwrap_or(support.add)
    };
    let (command, leading) = template.split_first().ok_or("empty command")?;
    let mut args: Vec<String> = leading.iter().map(|arg| (*arg).to_string()).collect();
    args.push(if installing {
        name.clone()
    } else {
        crate::deps::remove_argument(language, &name)
    });

    let _ = outbox.send(ServerEvent::DepsState {
        state: if installing {
            crate::protocol::DepsState::Installing
        } else {
            crate::protocol::DepsState::Removing
        },
        name: Some(name.clone()),
        error: None,
    });

    let mut env: Vec<(String, String)> = support
        .fetch_env
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    if !installing {
        // Removal is a local edit; keep it offline.
        env.retain(|(key, _)| key != "CARGO_NET_OFFLINE" && key != "GOPROXY");
    }

    let stdout_events = outbox.clone();
    let stderr_events = outbox.clone();
    let result = crate::supervisor::run(
        command,
        &args,
        crate::supervisor::RunOptions {
            cwd: session.root.clone(),
            // Fetching a dependency tree is slower than a build.
            limits: crate::supervisor::ProcessLimits::new(180_000, 512 * 1024, 512 * 1024),
            cancel: tokio_util::sync::CancellationToken::new(),
            probe_fd: false,
            env,
            sandbox: sandbox.clone(),
            callbacks: crate::supervisor::StreamCallbacks {
                stdout: Some(Box::new(move |chunk: &str| {
                    let _ = stdout_events.send(ServerEvent::DepsOutput {
                        stream: crate::protocol::Stream::Stdout,
                        chunk: chunk.to_string(),
                    });
                })),
                stderr: Some(Box::new(move |chunk: &str| {
                    let _ = stderr_events.send(ServerEvent::DepsOutput {
                        stream: crate::protocol::Stream::Stderr,
                        chunk: chunk.to_string(),
                    });
                })),
                probe: None,
            },
        },
    )
    .await;

    // Pull the sources too, while the grant is still open: the build that
    // follows runs offline and would fail on a missing download.
    let mut result = result;
    if installing && result.exit_code == Some(0) {
        if let Some(fetch) = support.fetch_after_add {
            let (fetch_command, fetch_args) = fetch.split_first().ok_or("empty fetch command")?;
            let fetch_events = outbox.clone();
            result = crate::supervisor::run(
                fetch_command,
                &fetch_args
                    .iter()
                    .map(|arg| (*arg).to_string())
                    .collect::<Vec<_>>(),
                crate::supervisor::RunOptions {
                    cwd: session.root.clone(),
                    limits: crate::supervisor::ProcessLimits::new(180_000, 512 * 1024, 512 * 1024),
                    cancel: tokio_util::sync::CancellationToken::new(),
                    probe_fd: false,
                    env: support
                        .fetch_env
                        .iter()
                        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                        .collect(),
                    sandbox: sandbox.clone(),
                    callbacks: crate::supervisor::StreamCallbacks {
                        stderr: Some(Box::new(move |chunk: &str| {
                            let _ = fetch_events.send(ServerEvent::DepsOutput {
                                stream: crate::protocol::Stream::Stderr,
                                chunk: chunk.to_string(),
                            });
                        })),
                        ..Default::default()
                    },
                },
            )
            .await;
        }
    }

    send_deps_catalog(session, outbox).await;
    if result.exit_code == Some(0) {
        let _ = outbox.send(ServerEvent::DepsState {
            state: crate::protocol::DepsState::Idle,
            name: Some(name),
            error: None,
        });
        Ok(())
    } else {
        let reason = if result.timed_out {
            "timed out".to_string()
        } else if result.stderr.is_empty() {
            format!("{command} exited with {:?}", result.exit_code)
        } else {
            result.stderr.clone()
        };
        let _ = outbox.send(ServerEvent::DepsState {
            state: crate::protocol::DepsState::Failed,
            name: Some(name),
            error: Some(reason),
        });
        Ok(())
    }
}

async fn handle_message(
    session: &Arc<Session>,
    scheduler: &Arc<RunScheduler>,
    outbox: &tokio::sync::mpsc::UnboundedSender<ServerEvent>,
    message: RuntimeClientMessage,
) -> Result<(), String> {
    match message {
        RuntimeClientMessage::DepsList { .. } => {
            send_deps_catalog(session, outbox).await;
            Ok(())
        }
        RuntimeClientMessage::DepsAdd { name, .. } => {
            run_deps_command(session, outbox, name, true).await
        }
        RuntimeClientMessage::DepsRemove { name, .. } => {
            run_deps_command(session, outbox, name, false).await
        }
        RuntimeClientMessage::DocumentUpdate {
            version,
            path,
            source,
            ..
        } => {
            let snapshot = session.update(version, &path, &source).await?;
            after_store_change(session, scheduler, outbox, &snapshot, &path).await;
            Ok(())
        }
        RuntimeClientMessage::FileCreate {
            version,
            path,
            source,
            ..
        } => {
            let snapshot = session.create_file(version, &path, &source).await?;
            after_store_change(session, scheduler, outbox, &snapshot, &path).await;
            Ok(())
        }
        RuntimeClientMessage::FileRename {
            version,
            path,
            new_path,
            ..
        } => {
            let snapshot = session.rename_file(version, &path, &new_path).await?;
            after_store_change(session, scheduler, outbox, &snapshot, &path).await;
            Ok(())
        }
        RuntimeClientMessage::FileDelete { version, path, .. } => {
            let snapshot = session.delete_file(version, &path).await?;
            after_store_change(session, scheduler, outbox, &snapshot, &path).await;
            Ok(())
        }
        RuntimeClientMessage::RunRequest {
            version, language, ..
        } => {
            let target = language.unwrap_or(session.language);
            if !session.support.get(&target).is_some_and(|s| s.run) {
                return Err(run_disabled_message(target));
            }
            if version != session.current().await.version {
                return Err("Run version is not current".to_string());
            }
            scheduler.run(version, Some(target)).await;
            Ok(())
        }
        RuntimeClientMessage::RunCancel { .. } => {
            scheduler.cancel().await;
            let version = session.current().await.version;
            let _ = outbox.send(ServerEvent::RunStateEvent {
                document_version: version,
                run_id: None,
                state: RunState::Cancelled,
            });
            Ok(())
        }
        RuntimeClientMessage::SettingsUpdate {
            auto_run,
            auto_inspect,
            debounce_ms,
            timeout_ms,
            manual_probe_ids,
            sandbox,
            network,
            ..
        } => {
            *session.settings.lock().await = SessionSettings {
                auto_run,
                auto_inspect,
                debounce_ms,
                timeout_ms,
                manual_probe_ids,
                // A client that predates the toggle keeps the default.
                sandbox: sandbox.unwrap_or_else(|| {
                    crate::sandbox::detect_support().available()
                }),
                network: network.unwrap_or(false),
            };
            Ok(())
        }
    }
}

async fn after_store_change(
    session: &Arc<Session>,
    scheduler: &Arc<RunScheduler>,
    outbox: &tokio::sync::mpsc::UnboundedSender<ServerEvent>,
    snapshot: &Snapshot,
    path: &str,
) {
    // project.files is not part of the typed ServerEvent enum (it carries the
    // full file list); send it raw through the same ordered channel.
    let _ = outbox.send(ServerEvent::ProjectFiles {
        document_version: snapshot.version,
        files: snapshot.files.clone(),
    });
    let language = packs::pack_for_path(path)
        .map(|p| p.id)
        .unwrap_or(session.language);
    if session.support.get(&language).is_some_and(|s| s.run) {
        scheduler.document_updated(Some(language)).await;
    } else {
        let _ = outbox.send(ServerEvent::RunStateEvent {
            document_version: snapshot.version,
            run_id: None,
            state: RunState::Idle,
        });
    }
}
