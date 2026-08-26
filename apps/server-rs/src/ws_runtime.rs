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

fn project_files_json(snapshot: &Snapshot) -> String {
    serde_json::json!({
        "type": "project.files",
        "documentVersion": snapshot.version,
        "files": snapshot.files,
    })
    .to_string()
}

fn run_disabled_message(language: Language) -> String {
    if language == Language::Rust {
        "Run is disabled: Rust 1.75+ is required. Run pnpm run doctor.".to_string()
    } else {
        "Run is disabled: Zig 0.16.x is required. Run pnpm run doctor.".to_string()
    }
}

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
    writer.abort();
    session.runtime_connected.store(false, Ordering::SeqCst);
    state.lsp_registry.close_session(&session.id).await;
    let state_for_destroy = Arc::clone(&state);
    let session_id = session.id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        state_for_destroy.sessions.destroy(&session_id).await;
    });
}

async fn handle_message(
    session: &Arc<Session>,
    scheduler: &Arc<RunScheduler>,
    outbox: &tokio::sync::mpsc::UnboundedSender<ServerEvent>,
    message: RuntimeClientMessage,
) -> Result<(), String> {
    match message {
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
            ..
        } => {
            *session.settings.lock().await = SessionSettings {
                auto_run,
                auto_inspect,
                debounce_ms,
                timeout_ms,
                manual_probe_ids,
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
