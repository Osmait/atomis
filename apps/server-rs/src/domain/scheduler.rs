//! RunScheduler mirrored from RunScheduler.ts: debounced auto-runs, run
//! cancellation/supersession, and translation of runner events into wire
//! events gated on the run still being current.

#![allow(dead_code)]

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::protocol::{Language, RunState, ServerEvent};
use crate::languages::runtime::{self, RunnerEvent};
use crate::domain::session::Session;
use crate::util::{now_ms, random_uuid};

pub type Outbox = UnboundedSender<ServerEvent>;

/// What actually executes a run. Injected so the scheduler's gating —
/// supersession, cancellation, panic recovery — is testable without a
/// toolchain on the machine.
type RunnerFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Option<runtime::RunnerOutcome>> + Send>,
>;
type Runner = Arc<
    dyn Fn(
            Language,
            Arc<Session>,
            crate::domain::session::Snapshot,
            crate::domain::session::SessionSettings,
            CancellationToken,
            UnboundedSender<RunnerEvent>,
        ) -> RunnerFuture
        + Send
        + Sync,
>;

struct Inner {
    debounce: Option<tokio::task::JoinHandle<()>>,
    cancel: Option<CancellationToken>,
    active_run: Option<String>,
    last_language: Language,
}

pub struct RunScheduler {
    session: Arc<Session>,
    outbox: Outbox,
    inner: Mutex<Inner>,
    runner: Runner,
}

impl RunScheduler {
    pub fn new(session: Arc<Session>, outbox: Outbox) -> Arc<Self> {
        Self::with_runner(
            session,
            outbox,
            Arc::new(|language, session, snapshot, settings, cancel, events| {
                Box::pin(async move {
                    runtime::run_language(language, &session, &snapshot, &settings, cancel, events)
                        .await
                }) as RunnerFuture
            }),
        )
    }

    fn with_runner(session: Arc<Session>, outbox: Outbox, runner: Runner) -> Arc<Self> {
        let language = session.language;
        Arc::new(RunScheduler {
            session,
            outbox,
            inner: Mutex::new(Inner {
                debounce: None,
                cancel: None,
                active_run: None,
                last_language: language,
            }),
            runner,
        })
    }

    fn send(&self, event: ServerEvent) {
        let _ = self.outbox.send(event);
    }

    pub async fn document_updated(self: &Arc<Self>, language: Option<Language>) {
        self.cancel_internal().await;
        let (version, debounce_ms, auto_run, target) = {
            let snapshot = self.session.current().await;
            let settings = self.session.settings.lock().await;
            let inner = self.inner.lock().await;
            (
                snapshot.version,
                settings.debounce_ms,
                settings.auto_run,
                language.unwrap_or(inner.last_language),
            )
        };
        if !auto_run {
            self.send(ServerEvent::RunStateEvent {
                document_version: version,
                run_id: None,
                state: RunState::Idle,
            });
            return;
        }
        self.send(ServerEvent::RunStateEvent {
            document_version: version,
            run_id: None,
            state: RunState::Debouncing,
        });
        let scheduler = Arc::clone(self);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(debounce_ms)).await;
            scheduler.run(version, Some(target)).await;
        });
        self.inner.lock().await.debounce = Some(handle);
    }

    pub async fn run(self: &Arc<Self>, version: u64, language: Option<Language>) {
        let snapshot = self.session.current().await;
        if snapshot.version != version {
            return;
        }
        let target = {
            let inner = self.inner.lock().await;
            language.unwrap_or(inner.last_language)
        };
        if !self
            .session
            .support
            .get(&target)
            .is_some_and(|support| support.present)
        {
            self.send(ServerEvent::ServerError {
                recoverable: true,
                message: format!("No runner available for {}", target.as_str()),
                details: None,
            });
            return;
        }
        self.cancel_internal().await;
        let run_id = random_uuid();
        let token = CancellationToken::new();
        {
            let mut inner = self.inner.lock().await;
            inner.last_language = target;
            inner.cancel = Some(token.clone());
            inner.active_run = Some(run_id.clone());
        }

        let scheduler = Arc::clone(self);
        let session = Arc::clone(&self.session);
        let settings = session.settings.lock().await.clone();
        let watchdog_run = run_id.clone();
        let run_task = tokio::spawn(async move {
            let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<RunnerEvent>();
            let forward_scheduler = Arc::clone(&scheduler);
            let forward_session = Arc::clone(&session);
            let forward_run = run_id.clone();
            let forward_token = token.clone();
            let forwarder = tokio::spawn(async move {
                while let Some(event) = events_rx.recv().await {
                    let current = {
                        let inner = forward_scheduler.inner.lock().await;
                        !forward_token.is_cancelled()
                            && inner.active_run.as_deref() == Some(forward_run.as_str())
                    } && forward_session.current().await.version == version;
                    if !current {
                        continue;
                    }
                    forward_scheduler.send(translate(
                        event,
                        version,
                        &forward_run,
                        &forward_session.id,
                    ));
                }
            });

            let outcome = (scheduler.runner)(
                target,
                Arc::clone(&session),
                snapshot.clone(),
                settings,
                token.clone(),
                events_tx.clone(),
            )
            .await;
            drop(events_tx);
            let _ = forwarder.await;

            let current = {
                let inner = scheduler.inner.lock().await;
                !token.is_cancelled() && inner.active_run.as_deref() == Some(run_id.as_str())
            } && session.current().await.version == version;
            if let Some(outcome) = outcome {
                if current {
                    scheduler.send(ServerEvent::RunStateEvent {
                        document_version: version,
                        run_id: Some(run_id.clone()),
                        state: outcome.terminal_state.as_run_state(),
                    });
                    scheduler.send(ServerEvent::RunFinished {
                        document_version: version,
                        run_id: run_id.clone(),
                        result: outcome.result,
                    });
                }
            } else if current {
                scheduler.send(ServerEvent::ServerError {
                    recoverable: true,
                    message: format!("No runner available for {}", target.as_str()),
                    details: None,
                });
            }
            let mut inner = scheduler.inner.lock().await;
            if inner.active_run.as_deref() == Some(run_id.as_str()) {
                inner.active_run = None;
                inner.cancel = None;
            }
        });

        // A panic anywhere in the runner unwinds past every cleanup above:
        // the slot stays taken and the UI stays on Compiling forever. The
        // watchdog is outside the blast radius.
        let watchdog = Arc::clone(self);
        tokio::spawn(async move {
            if run_task.await.is_err() {
                let mut inner = watchdog.inner.lock().await;
                let ours = inner.active_run.as_deref() == Some(watchdog_run.as_str());
                if ours {
                    inner.active_run = None;
                    inner.cancel = None;
                }
                drop(inner);
                if ours {
                    watchdog.send(ServerEvent::RunStateEvent {
                        document_version: version,
                        run_id: Some(watchdog_run.clone()),
                        state: RunState::Idle,
                    });
                    watchdog.send(ServerEvent::ServerError {
                        recoverable: true,
                        message: "The run crashed inside the server and was reset".to_string(),
                        details: None,
                    });
                }
            }
        });
    }

    async fn cancel_internal(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(handle) = inner.debounce.take() {
            handle.abort();
        }
        if let Some(token) = inner.cancel.take() {
            token.cancel();
        }
        inner.active_run = None;
    }

    pub async fn cancel(&self) {
        self.cancel_internal().await;
    }

    pub async fn close(&self) {
        self.cancel_internal().await;
    }
}

fn translate(event: RunnerEvent, version: u64, run_id: &str, session_id: &str) -> ServerEvent {
    match event {
        RunnerEvent::State(state) => ServerEvent::RunStateEvent {
            document_version: version,
            run_id: Some(run_id.to_string()),
            state,
        },
        RunnerEvent::Catalog(probes) => ServerEvent::ProbeCatalog {
            document_version: version,
            probes,
        },
        RunnerEvent::TestCatalog(tests) => ServerEvent::TestCatalog {
            document_version: version,
            tests,
        },
        RunnerEvent::TestResult {
            test_id,
            name,
            status,
            duration_ms,
            message,
        } => ServerEvent::TestResult {
            document_version: version,
            run_id: run_id.to_string(),
            test_id,
            name,
            status,
            duration_ms,
            message,
        },
        RunnerEvent::TestSummary {
            passed,
            failed,
            skipped,
            leaked,
            duration_ms,
        } => ServerEvent::TestSummary {
            document_version: version,
            run_id: run_id.to_string(),
            passed,
            failed,
            skipped,
            leaked,
            duration_ms,
        },
        RunnerEvent::Output {
            stream,
            chunk,
            category,
            source_location,
        } => ServerEvent::Output {
            document_version: version,
            run_id: run_id.to_string(),
            stream,
            category,
            chunk,
            source_location,
        },
        RunnerEvent::Diagnostic { owner, diagnostics } => ServerEvent::Diagnostics {
            document_version: version,
            owner,
            diagnostics,
        },
        RunnerEvent::Probe { raw, path, count } => ServerEvent::ProbeValue {
            protocol_version: 1,
            kind: "probe_value",
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            document_version: version,
            probe_id: raw.probe_id,
            path,
            name: raw.name,
            line: raw.line,
            column: raw.column,
            type_name: raw.type_name,
            preview: raw.preview,
            truncated: raw.truncated,
            sequence: raw.sequence,
            timestamp: now_ms(),
            count,
            bits: raw.bits,
            size_bytes: raw.size_bytes,
            align_bytes: raw.align_bytes,
            fields: raw.fields,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::session::{LanguageSupport, SessionSettings, Snapshot};
    use crate::protocol::ProjectFile;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_session(settings: SessionSettings) -> Arc<Session> {
        let root = std::path::PathBuf::from("/tmp/atomis-sched-test");
        let mut support = HashMap::new();
        support.insert(
            Language::Zig,
            LanguageSupport {
                present: true,
                run: true,
                lsp: false,
            },
        );
        Arc::new(Session {
            id: "test-session".into(),
            token: "t".into(),
            language: Language::Zig,
            entry_paths: vec!["main.zig".into()],
            root: root.clone(),
            source_root: root.join("src"),
            document_uri: "file:///x/main.zig".into(),
            snapshot: Mutex::new(Snapshot {
                version: 1,
                uri: "file:///x/main.zig".into(),
                source: String::new(),
                files: vec![ProjectFile {
                    path: "main.zig".into(),
                    uri: "file:///x/main.zig".into(),
                    source: String::new(),
                }],
                updated_at: 0,
            }),
            settings: Mutex::new(settings),
            probes: Mutex::new(Vec::new()),
            support,
            runtime_connected: std::sync::atomic::AtomicBool::new(false),
            attach_generation: std::sync::atomic::AtomicU64::new(0),
            sandbox_policy: std::sync::Arc::new(crate::exec::sandbox::policy_for(
                &root, &root, None,
            )),
            workspace_id: None,
        })
    }

    fn counting_runner(runs: Arc<AtomicUsize>) -> Runner {
        Arc::new(move |_, _, _, _, _, _| {
            runs.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { None }) as RunnerFuture
        })
    }

    #[tokio::test]
    async fn a_cancelled_run_finishing_late_says_nothing() {
        let session = test_session(SessionSettings::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let gate = Arc::new(tokio::sync::Notify::new());
        let release = Arc::clone(&gate);
        let runner: Runner = Arc::new(move |_, _, _, _, _, _| {
            let release = Arc::clone(&release);
            Box::pin(async move {
                release.notified().await;
                None
            }) as RunnerFuture
        });
        let scheduler = RunScheduler::with_runner(session, tx, runner);
        scheduler.run(1, Some(Language::Zig)).await;
        while rx.try_recv().is_ok() {} // the run's own state events
        scheduler.cancel().await;
        gate.notify_waiters();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // The dead run finished after supersession: it must say nothing —
        // no RunFinished, no "no runner" error over the current state.
        let mut leaked = 0;
        while let Ok(event) = rx.try_recv() {
            if matches!(
                event,
                ServerEvent::RunFinished { .. } | ServerEvent::ServerError { .. }
            ) {
                leaked += 1;
            }
        }
        assert_eq!(leaked, 0, "a superseded run must stay silent");
    }

    #[tokio::test]
    async fn a_panicking_runner_frees_the_slot_and_tells_the_client() {
        let session = test_session(SessionSettings::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let runner: Runner = Arc::new(|_, _, _, _, _, _| {
            Box::pin(async {
                panic!("runner exploded");
                #[allow(unreachable_code)]
                None
            }) as RunnerFuture
        });
        let scheduler = RunScheduler::with_runner(session, tx, runner);
        scheduler.run(1, Some(Language::Zig)).await;

        let mut saw_error = false;
        let mut saw_idle = false;
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            while let Ok(event) = rx.try_recv() {
                match event {
                    ServerEvent::ServerError { .. } => saw_error = true,
                    ServerEvent::RunStateEvent {
                        state: RunState::Idle,
                        ..
                    } => saw_idle = true,
                    _ => {}
                }
            }
            if saw_error && saw_idle {
                break;
            }
        }
        assert!(saw_error, "the client must hear that the run died");
        assert!(saw_idle, "the spinner must be released");
        assert!(
            scheduler.inner.lock().await.active_run.is_none(),
            "the slot must be free for the next run"
        );
    }

    #[tokio::test]
    async fn a_burst_of_edits_runs_once_after_the_debounce() {
        let settings = SessionSettings {
            debounce_ms: 30,
            ..SessionSettings::default()
        };
        let session = test_session(settings);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let runs = Arc::new(AtomicUsize::new(0));
        let scheduler =
            RunScheduler::with_runner(session, tx, counting_runner(Arc::clone(&runs)));
        for _ in 0..3 {
            scheduler.document_updated(None).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 1, "one run per burst");
    }

    #[tokio::test]
    async fn auto_run_off_reports_idle_and_runs_nothing() {
        let settings = SessionSettings {
            auto_run: false,
            ..SessionSettings::default()
        };
        let session = test_session(settings);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let runs = Arc::new(AtomicUsize::new(0));
        let scheduler =
            RunScheduler::with_runner(session, tx, counting_runner(Arc::clone(&runs)));
        scheduler.document_updated(None).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        let mut saw_idle = false;
        while let Ok(event) = rx.try_recv() {
            if matches!(
                event,
                ServerEvent::RunStateEvent {
                    state: RunState::Idle,
                    ..
                }
            ) {
                saw_idle = true;
            }
        }
        assert!(saw_idle, "the client is told the edit will not run");
    }
}

