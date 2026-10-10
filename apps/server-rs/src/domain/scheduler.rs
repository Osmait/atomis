//! RunScheduler mirrored from RunScheduler.ts: debounced auto-runs, run
//! cancellation/supersession, and translation of runner events into wire
//! events gated on the run still being current.

#![allow(dead_code)]

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

use crate::protocol::{Language, RunState, ServerEvent};
use crate::languages::runtime::{self, RunnerEvent};
use crate::domain::session::Session;
use crate::util::{now_ms, random_uuid};

pub type Outbox = UnboundedSender<ServerEvent>;

/// How many runs may compile or execute at once, across every session:
/// `ATOMIS_MAX_CONCURRENT_RUNS`, unlimited when unset or `0`.
///
/// A hard ceiling for small plans, off by default because measuring it
/// argued against it: on 2 vCPUs with 8 people, one slot per CPU tripled
/// the median run (a 40 ms Python run queued behind 1-2 s Zig builds,
/// where the scheduler used to interleave them) and still did not beat
/// unlimited at the tail. What had pushed memory to the container's limit
/// under load was every new session rebuilding Go's standard library,
/// fixed by sharing its cache; unlimited now peaks under 1 GB with 16.
fn run_slots(raw: Option<&str>) -> usize {
    raw.and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|slots| *slots > 0)
        .unwrap_or(tokio::sync::Semaphore::MAX_PERMITS)
}

static RUN_SLOTS: std::sync::LazyLock<tokio::sync::Semaphore> = std::sync::LazyLock::new(|| {
    tokio::sync::Semaphore::new(run_slots(
        std::env::var("ATOMIS_MAX_CONCURRENT_RUNS").ok().as_deref(),
    ))
});

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

/// How long a new run waits for the one it superseded to wind down. A
/// cancelled run's processes get SIGTERM, then SIGKILL 250 ms later; this
/// only bounds a runner that ignores its token.
const SUPERSEDED_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// An interactive run waits on a person, not a program, so the per-run
/// timeout (at most 10 s) does not fit it; Stop ends one sooner.
pub const INTERACTIVE_TIMEOUT_MS: u64 = 5 * 60 * 1000;

type LiveSender = tokio::sync::mpsc::UnboundedSender<crate::exec::supervisor::LiveInput>;

struct Inner {
    /// The pending auto run, tagged so its own task can tell it is still
    /// the pending one.
    debounce: Option<(u64, tokio::task::JoinHandle<()>)>,
    debounce_seq: u64,
    cancel: Option<CancellationToken>,
    active_run: Option<String>,
    last_language: Language,
    /// Fires once the latest run's task has ended, however it ended.
    finished: Option<CancellationToken>,
    /// The interactive run's input, while it runs. Dropping it closes the
    /// program's stdin.
    live_input: Option<LiveSender>,
}

pub struct RunScheduler {
    session: Arc<Session>,
    outbox: Outbox,
    inner: Mutex<Inner>,
    runner: Runner,
    /// Held from cancelling the previous run to spawning the next, so two
    /// starts (a debounced auto run and a manual one) cannot interleave.
    start: Mutex<()>,
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
                debounce_seq: 0,
                cancel: None,
                active_run: None,
                last_language: language,
                finished: None,
                live_input: None,
            }),
            runner,
            start: Mutex::new(()),
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
        // Held across the spawn, so the task cannot look for its tag before
        // it is stored.
        let mut inner = self.inner.lock().await;
        inner.debounce_seq += 1;
        let tag = inner.debounce_seq;
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(debounce_ms)).await;
            // From here on this task IS the run's start: it leaves the pending
            // slot first, or starting the run — which cancels whatever auto
            // run is pending — would abort the very task doing it, the moment
            // it waits for the superseded run.
            {
                let mut inner = scheduler.inner.lock().await;
                if inner.debounce.as_ref().map(|(pending, _)| *pending) != Some(tag) {
                    return;
                }
                inner.debounce = None;
            }
            scheduler.run(version, Some(target)).await;
        });
        inner.debounce = Some((tag, handle));
    }

    pub async fn run(self: &Arc<Self>, version: u64, language: Option<Language>) {
        self.start_run(version, language, false).await;
    }

    /// A run whose program reads what the user types (`write_stdin`)
    /// instead of the Input text, with time to wait for it.
    pub async fn run_interactive(self: &Arc<Self>, version: u64, language: Option<Language>) {
        self.start_run(version, language, true).await;
    }

    /// Hands typed input to the interactive run's program.
    pub async fn write_stdin(&self, input: crate::exec::supervisor::LiveInput) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let eof = input == crate::exec::supervisor::LiveInput::Eof;
        let sent = inner
            .live_input
            .as_ref()
            .is_some_and(|sender| sender.send(input).is_ok());
        if eof {
            inner.live_input = None;
        }
        if sent {
            Ok(())
        } else {
            Err("No program is waiting for input".to_string())
        }
    }

    async fn start_run(self: &Arc<Self>, version: u64, language: Option<Language>, interactive: bool) {
        let _start = self.start.lock().await;
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
        // Cancelling only asks. The superseded run may still be winding down
        // — its processes dying, its runner short of its next check — and it
        // shares generated/ with this one: started alongside it, this run had
        // its freshly written sources deleted by the old run's reset.
        let previous = self.inner.lock().await.finished.take();
        if let Some(previous) = previous {
            if tokio::time::timeout(SUPERSEDED_GRACE, previous.cancelled())
                .await
                .is_err()
            {
                tracing::warn!("a superseded run outlived its grace; starting anyway");
            }
            // The wait may have outlasted the edit this run was for.
            if self.session.current().await.version != version {
                return;
            }
        }
        let run_id = random_uuid();
        let token = CancellationToken::new();
        let finished = CancellationToken::new();
        // Every run sets the slot, so a receiver left by an interactive run
        // cancelled before its program started cannot reach a later one.
        let (live_sender, live_receiver) = if interactive {
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        *self.session.live_stdin.lock().await = live_receiver;
        {
            let mut inner = self.inner.lock().await;
            inner.last_language = target;
            inner.cancel = Some(token.clone());
            inner.active_run = Some(run_id.clone());
            inner.finished = Some(finished.clone());
            inner.live_input = live_sender;
        }
        if interactive {
            self.send(ServerEvent::StdinOpen {
                document_version: version,
                run_id: run_id.clone(),
            });
        }

        let scheduler = Arc::clone(self);
        let session = Arc::clone(&self.session);
        let mut settings = session.settings.lock().await.clone();
        settings.interactive = interactive;
        let watchdog_run = run_id.clone();
        // The run's row in an ATOMIS_TRACE timeline; everything below lands
        // on it, the phases included.
        let run_span = tracing::info_span!(
            "run",
            run = %run_id.get(..8).unwrap_or(&run_id),
            language = target.as_str(),
            version,
        );
        let run_task = tokio::spawn(async move {
            let phase_parent = tracing::Span::current();
            let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<RunnerEvent>();
            let forward_scheduler = Arc::clone(&scheduler);
            let forward_session = Arc::clone(&session);
            let forward_run = run_id.clone();
            let forward_token = token.clone();
            let forwarder = tokio::spawn(async move {
                // One span per state the runner reports, each closed by the
                // next: the phases, as the runner itself sees them.
                let mut phase: Option<tracing::Span> = None;
                while let Some(event) = events_rx.recv().await {
                    if let RunnerEvent::State(state) = &event {
                        phase = Some(tracing::info_span!(parent: &phase_parent, "phase", label = ?state));
                    }
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
                drop(phase);
            });

            let started = std::time::Instant::now();
            // Waiting for a slot is part of the wait the person sees, so it
            // stays inside the measured run; a run superseded while queued
            // leaves the queue without ever starting.
            let queued = crate::metrics::METRICS.run_queued();
            let slot = async {
                tokio::select! {
                    slot = RUN_SLOTS.acquire() => slot.ok(),
                    () = token.cancelled() => None,
                }
            }
            .instrument(tracing::info_span!("queued"))
            .await;
            drop(queued);
            let in_flight = slot.as_ref().map(|_| crate::metrics::METRICS.run_started());
            let outcome = match slot {
                Some(_slot) => {
                    (scheduler.runner)(
                        target,
                        Arc::clone(&session),
                        snapshot.clone(),
                        settings,
                        token.clone(),
                        events_tx.clone(),
                    )
                    .instrument(tracing::info_span!("runner"))
                    .await
                }
                None => None,
            };
            drop(events_tx);
            let _ = forwarder.instrument(tracing::info_span!("drain events")).await;
            drop(in_flight);
            // Counted whether or not anyone is still waiting for it: a
            // superseded run cost the same CPU as one that was shown.
            if let Some(outcome) = &outcome {
                crate::metrics::METRICS.run_finished(
                    target,
                    outcome.terminal_state,
                    started.elapsed().as_secs_f64(),
                    &outcome.result,
                );
            }

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
                inner.live_input = None;
            }
        }.instrument(run_span));

        // A panic anywhere in the runner unwinds past every cleanup above:
        // the slot stays taken and the UI stays on Compiling forever. The
        // watchdog is outside the blast radius.
        let watchdog = Arc::clone(self);
        tokio::spawn(async move {
            let ended = run_task.await;
            finished.cancel();
            if ended.is_err() {
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
        if let Some((_, handle)) = inner.debounce.take() {
            handle.abort();
        }
        if let Some(token) = inner.cancel.take() {
            token.cancel();
        }
        inner.active_run = None;
        inner.live_input = None;
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
            entry_path: "main.zig".into(),
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
            input: tokio::sync::Mutex::new(Arc::from("")),
            live_stdin: tokio::sync::Mutex::new(None),
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
    async fn a_new_run_starts_only_after_the_superseded_one_has_wound_down() {
        // Run 1 takes a while to let go once cancelled, as a runner past its
        // last check does; run 2 must not start under it — they share
        // generated/, and the old run's cleanup would delete the new run's
        // sources.
        let session = test_session(SessionSettings::default());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let log = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let runner: Runner = {
            let log = Arc::clone(&log);
            Arc::new(move |_, _, _, _, cancel: CancellationToken, _| {
                let log = Arc::clone(&log);
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                Box::pin(async move {
                    if first {
                        cancel.cancelled().await;
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                        log.lock().unwrap().push("first ended");
                    } else {
                        log.lock().unwrap().push("second started");
                    }
                    None
                }) as RunnerFuture
            })
        };
        let scheduler = RunScheduler::with_runner(session, tx, runner);
        scheduler.run(1, Some(Language::Zig)).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        scheduler.run(1, Some(Language::Zig)).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(*log.lock().unwrap(), ["first ended", "second started"]);
    }

    #[tokio::test]
    async fn an_interactive_run_reads_what_is_typed_and_has_time_for_it() {
        use crate::exec::supervisor::{LiveInput, Stdin};
        let session = test_session(SessionSettings::default());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel::<(u64, Vec<u8>)>();
        let runner: Runner = Arc::new(move |_, session: Arc<Session>, _, settings: SessionSettings, _, _| {
            let seen_tx = seen_tx.clone();
            Box::pin(async move {
                if let Stdin::Live(mut input) = session.stdin().await {
                    while let Some(LiveInput::Data(bytes)) = input.recv().await {
                        let _ = seen_tx.send((settings.program_timeout_ms(), bytes));
                    }
                }
                None
            }) as RunnerFuture
        });
        let scheduler = RunScheduler::with_runner(session, tx, runner);
        assert!(
            scheduler.write_stdin(LiveInput::Data(b"early".to_vec())).await.is_err(),
            "nothing is waiting before the run"
        );
        scheduler.run_interactive(1, Some(Language::Zig)).await;
        scheduler.write_stdin(LiveInput::Data(b"42\n".to_vec())).await.unwrap();
        let (timeout, bytes) = tokio::time::timeout(std::time::Duration::from_secs(2), seen.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bytes, b"42\n");
        assert_eq!(timeout, INTERACTIVE_TIMEOUT_MS);
        scheduler.write_stdin(LiveInput::Eof).await.unwrap();
        assert!(
            scheduler.write_stdin(LiveInput::Data(b"late".to_vec())).await.is_err(),
            "after EOF there is nothing to write to"
        );
    }

    #[tokio::test]
    async fn a_plain_run_never_inherits_an_interactive_runs_input() {
        use crate::exec::supervisor::Stdin;
        let session = test_session(SessionSettings::default());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (kinds_tx, mut kinds) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let first_started = Arc::clone(&started);
        let runner: Runner = Arc::new(move |_, session: Arc<Session>, _, _, cancel: CancellationToken, _| {
            let kinds_tx = kinds_tx.clone();
            let first_started = Arc::clone(&first_started);
            let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            Box::pin(async move {
                if first {
                    first_started.notify_one();
                    // Cancelled before its program started: the receiver
                    // is still in the session.
                    cancel.cancelled().await;
                    return None;
                }
                let kind = match session.stdin().await {
                    Stdin::Live(_) => "live",
                    Stdin::Text(_) => "text",
                    Stdin::Null => "null",
                };
                let _ = kinds_tx.send(kind);
                None
            }) as RunnerFuture
        });
        let scheduler = RunScheduler::with_runner(session, tx, runner);
        scheduler.run_interactive(1, Some(Language::Zig)).await;
        started.notified().await;
        scheduler.run(1, Some(Language::Zig)).await;
        let kind = tokio::time::timeout(std::time::Duration::from_secs(2), kinds.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kind, "null");
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

    #[test]
    fn runs_are_unlimited_unless_a_ceiling_is_configured() {
        let unlimited = tokio::sync::Semaphore::MAX_PERMITS;
        assert_eq!(run_slots(None), unlimited);
        assert_eq!(run_slots(Some(" 4 ")), 4);
        // Zero would queue every run forever; it means "no ceiling".
        assert_eq!(run_slots(Some("0")), unlimited);
        assert_eq!(run_slots(Some("many")), unlimited);
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
    async fn an_auto_run_starts_even_when_the_run_it_supersedes_is_slow_to_go() {
        // The debounced run's own task starts it, and starting cancels the
        // pending auto run: that must not be the task itself, or it dies
        // while waiting for the old run and nothing ever runs.
        let settings = SessionSettings {
            debounce_ms: 30,
            ..SessionSettings::default()
        };
        let session = test_session(settings);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let runner: Runner = {
            let calls = Arc::clone(&calls);
            let started = Arc::clone(&started);
            Arc::new(move |_, _, _, _, cancel: CancellationToken, _| {
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                let started = Arc::clone(&started);
                Box::pin(async move {
                    if first {
                        started.notify_one();
                        cancel.cancelled().await;
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    }
                    None
                }) as RunnerFuture
            })
        };
        let scheduler = RunScheduler::with_runner(session, tx, runner);
        scheduler.run(1, Some(Language::Zig)).await;
        started.notified().await;
        scheduler.document_updated(None).await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "the auto run must start");
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

