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
}

impl RunScheduler {
    pub fn new(session: Arc<Session>, outbox: Outbox) -> Arc<Self> {
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
        tokio::spawn(async move {
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

            let outcome = runtime::run_language(
                target,
                &session,
                &snapshot,
                &settings,
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
