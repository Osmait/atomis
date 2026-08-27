//! Python runner mirrored from PyCompilerRunner.ts: instrument via python3,
//! run `python3 -u generated/main.py` with the sitecustomize runtime on
//! PYTHONPATH, tests via the custom stdlib runner emitting NDJSON on fd 3.

use std::sync::{Arc, Mutex as StdMutex};

use tokio_util::sync::CancellationToken;

use crate::ndjson::{RawTestEvent, RawTestStatus, TestReader};
use crate::packs;
use crate::protocol::{
    AppDiagnostic, Language, OutputCategory, RunResult, RunState, Severity, Stream, TestCase,
    TestStatus,
};
use crate::session::{Session, SessionSettings, Snapshot};
use crate::supervisor::{self, ProcessLimits, RunOptions, StreamCallbacks};

use super::common::{
    classify_execution, execute_program, instrument_files, truncate_chars, ExecuteConfig,
    InstrumentConfig,
};
use super::{cancelled_outcome, reset_generated, Events, RunnerEvent, RunnerOutcome, TerminalState};

pub fn is_py_test_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    (name.starts_with("test_") && name.ends_with(".py")) || name.ends_with("_test.py")
}

pub fn discover_py_tests(files: &[crate::protocol::ProjectFile]) -> Vec<TestCase> {
    let mut tests = Vec::new();
    for file in files {
        if !is_py_test_file(&file.path) {
            continue;
        }
        for (index, line) in file.source.split('\n').enumerate() {
            let Some(rest) = line.strip_prefix("def test_") else {
                continue;
            };
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            let after = &rest[name.len()..];
            if !after.trim_start().starts_with('(') {
                continue;
            }
            tests.push(TestCase {
                test_id: format!("{}:{}", file.path, index + 1),
                path: format!("src/{}", file.path),
                name: format!("test_{name}"),
                line: (index + 1) as u32,
                column: 1,
            });
        }
    }
    tests
}

pub fn match_py_test_name<'a>(catalog: &'a [TestCase], runner_name: &str) -> Option<&'a TestCase> {
    let (module_name, title) = match runner_name.rfind('.') {
        Some(index) => (&runner_name[..index], &runner_name[index + 1..]),
        None => ("", runner_name),
    };
    let by_title: Vec<&TestCase> = catalog.iter().filter(|c| c.name == title).collect();
    if by_title.len() <= 1 {
        return by_title.first().copied();
    }
    by_title
        .iter()
        .find(|candidate| {
            let stem = candidate
                .path
                .strip_prefix("src/")
                .unwrap_or(&candidate.path)
                .strip_suffix(".py")
                .unwrap_or(&candidate.path)
                .rsplit('/')
                .next()
                .unwrap_or("");
            stem == module_name
        })
        .copied()
        .or_else(|| by_title.first().copied())
}

fn py_env(root: &std::path::Path, with_runtime: bool) -> Vec<(String, String)> {
    let mut env = vec![("PYTHONDONTWRITEBYTECODE".into(), "1".into())];
    if with_runtime {
        env.push((
            "PYTHONPATH".into(),
            root.join("generated").to_string_lossy().into_owned(),
        ));
    }
    env
}

pub async fn run(
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> RunnerOutcome {
    let mut metrics = RunResult::default();
    let emit = |event: RunnerEvent| {
        let _ = events.send(event);
    };

    emit(RunnerEvent::State(RunState::Instrumenting));
    let test_catalog = discover_py_tests(&snapshot.files);
    emit(RunnerEvent::TestCatalog(test_catalog.clone()));
    let _ = reset_generated(&session.root).await;
    let instrumenter = packs::instrumenter_path(Language::Py);
    let outcome = instrument_files(
        session,
        snapshot,
        settings,
        &cancel,
        &events,
        InstrumentConfig {
            source_name: "pylive-instrument",
            instruments: &|path| path.ends_with(".py") && !is_py_test_file(path),
            command: "python3".to_string(),
            command_prefix_args: vec![instrumenter.to_string_lossy().into_owned()],
            extra_args: &|_| Vec::new(),
            timeout_ms: 10_000,
        },
    )
    .await;
    metrics.instrumentation_ms = outcome.duration_ms;
    if outcome.cancelled {
        return cancelled_outcome(metrics, "superseded");
    }
    *session.probes.lock().await = outcome.probes.clone();
    emit(RunnerEvent::Catalog(outcome.probes.clone()));
    emit(RunnerEvent::Diagnostic {
        owner: "atomis-instrumenter".to_string(),
        diagnostics: outcome.diagnostics.clone(),
    });
    if !outcome.diagnostics.is_empty() {
        metrics.reason = Some("instrumentation error".to_string());
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::CompileError,
        };
    }

    emit(RunnerEvent::State(RunState::Running));
    let entry = session.root.join("generated/main.py");
    let execution = execute_program(
        &outcome.probes,
        &outcome.file_ids,
        &cancel,
        &events,
        ExecuteConfig {
            command: "python3".to_string(),
            args: vec!["-u".into(), entry.to_string_lossy().into_owned()],
            cwd: session.root.join("src"),
            env: py_env(&session.root, true),
            timeout_ms: settings.timeout_ms,
            parse_stdout_markers: true,
        },
    )
    .await;
    if let Some(outcome) = classify_execution(&mut metrics, &execution, &cancel) {
        return outcome;
    }
    let result = &execution.result;
    if result.exit_code != Some(0) || result.signal.is_some() {
        let location = last_py_location(&result.stderr);
        emit(RunnerEvent::Diagnostic {
            owner: "runtime".to_string(),
            diagnostics: vec![AppDiagnostic {
                message: "Program raised or exited abnormally".to_string(),
                path: location.as_ref().map(|(path, _)| format!("src/{path}")),
                severity: Severity::Error,
                line: location.as_ref().map(|(_, line)| *line).unwrap_or(1),
                column: 1,
                end_line: None,
                end_column: None,
                code: None,
                source: Some("runtime".to_string()),
            }],
        });
        run_tests(session, settings, &test_catalog, &cancel, &events).await;
        metrics.reason = Some("abnormal exit".to_string());
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::RuntimeError,
        };
    }
    emit(RunnerEvent::Diagnostic {
        owner: "runtime".to_string(),
        diagnostics: Vec::new(),
    });
    run_tests(session, settings, &test_catalog, &cancel, &events).await;
    RunnerOutcome {
        result: metrics,
        terminal_state: TerminalState::Succeeded,
    }
}

/// Last `File "…/generated|src/x.py", line N` occurrence in a traceback.
fn last_py_location(stderr: &str) -> Option<(String, u32)> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"File "(?:.*[/\\])?(?:generated|src)[/\\]([\w./-]+\.py)", line (\d+)"#)
            .expect("static")
    });
    re.captures_iter(stderr)
        .last()
        .and_then(|capture| {
            Some((
                capture.get(1)?.as_str().to_string(),
                capture.get(2)?.as_str().parse().ok()?,
            ))
        })
}

async fn run_tests(
    session: &Session,
    settings: &SessionSettings,
    catalog: &[TestCase],
    cancel: &CancellationToken,
    events: &Events,
) {
    if catalog.is_empty() || cancel.is_cancelled() {
        return;
    }
    let _ = events.send(RunnerEvent::State(RunState::Testing));

    struct TestState {
        started: std::collections::HashMap<u32, String>,
        counts: (u32, u32, u32),
        stderr_buffer: String,
        summary: Option<(u32, u32, u32)>,
    }
    let state = Arc::new(StdMutex::new(TestState {
        started: std::collections::HashMap::new(),
        counts: (0, 0, 0),
        stderr_buffer: String::new(),
        summary: None,
    }));

    let reader_state = Arc::clone(&state);
    let reader_events = events.clone();
    let catalog_owned = catalog.to_vec();
    let mut reader = TestReader::new(Box::new(move |event| {
        let mut state = reader_state.lock().expect("py test state");
        match event {
            RawTestEvent::TestStart { index, name } => {
                state.started.insert(index, name);
                state.stderr_buffer.clear();
            }
            RawTestEvent::TestResult {
                index,
                name,
                status,
                duration_ns,
                error,
            } => {
                state.started.remove(&index);
                let status = match status {
                    RawTestStatus::Passed => TestStatus::Passed,
                    RawTestStatus::Skipped => TestStatus::Skipped,
                    _ => TestStatus::Failed,
                };
                match status {
                    TestStatus::Passed => state.counts.0 += 1,
                    TestStatus::Failed => state.counts.1 += 1,
                    _ => state.counts.2 += 1,
                }
                let matched = match_py_test_name(&catalog_owned, &name);
                let tail = state.stderr_buffer.trim().to_string();
                let message = if status == TestStatus::Failed {
                    if tail.is_empty() {
                        error
                    } else {
                        Some(truncate_chars(&tail, 1200))
                    }
                } else {
                    None
                };
                let _ = reader_events.send(RunnerEvent::TestResult {
                    test_id: matched.map(|m| m.test_id.clone()),
                    name: matched.map(|m| m.name.clone()).unwrap_or(name),
                    status,
                    duration_ms: duration_ns / 1_000_000.0,
                    message,
                });
                state.stderr_buffer.clear();
            }
            RawTestEvent::TestSummary {
                passed,
                failed,
                skipped,
                ..
            } => {
                state.summary = Some((passed, failed, skipped));
            }
        }
    }));

    let runner = packs::project_root().join("python/test-runner/atomis_test_runner.py");
    let mut args: Vec<String> = vec!["-u".into(), runner.to_string_lossy().into_owned()];
    let mut seen = std::collections::HashSet::new();
    for test in catalog {
        let path = session.root.join(&test.path).to_string_lossy().into_owned();
        if seen.insert(path.clone()) {
            args.push(path);
        }
    }
    let stderr_state = Arc::clone(&state);
    let execution = {
        let reader_ref = &mut reader;
        supervisor::run(
            "python3",
            &args,
            RunOptions {
                cwd: session.root.join("src"),
                limits: ProcessLimits::new(settings.timeout_ms.max(3000), 512 * 1024, 512 * 1024),
                cancel: cancel.clone(),
                probe_fd: true,
                env: py_env(&session.root, false),
                callbacks: StreamCallbacks {
                    stdout: None,
                    stderr: Some(Box::new(move |chunk: &str| {
                        stderr_state
                            .lock()
                            .expect("py stderr")
                            .stderr_buffer
                            .push_str(chunk);
                    })),
                    probe: Some(Box::new(move |chunk: &[u8]| reader_ref.push(chunk))),
                },
            },
        )
        .await
    };
    reader.end();
    let read_error = reader.error.clone();
    if execution.cancelled || cancel.is_cancelled() {
        return;
    }
    let mut state = state.lock().expect("py test state");
    let started: Vec<String> = state.started.values().cloned().collect();
    for name in started {
        state.counts.1 += 1;
        let matched = match_py_test_name(catalog, &name);
        let tail = truncate_chars(state.stderr_buffer.trim(), 1200);
        let _ = events.send(RunnerEvent::TestResult {
            test_id: matched.map(|m| m.test_id.clone()),
            name: matched.map(|m| m.name.clone()).unwrap_or(name),
            status: if execution.timed_out {
                TestStatus::TimedOut
            } else {
                TestStatus::Failed
            },
            duration_ms: 0.0,
            message: if tail.is_empty() { None } else { Some(tail) },
        });
        state.stderr_buffer.clear();
    }
    if state.summary.is_none()
        && execution.exit_code != Some(0)
        && !state.stderr_buffer.trim().is_empty()
    {
        let _ = events.send(RunnerEvent::Output {
            stream: Stream::Stderr,
            chunk: state.stderr_buffer.clone(),
            category: OutputCategory::Error,
            source_location: None,
        });
    }
    if let Some(message) = read_error {
        let _ = events.send(RunnerEvent::Output {
            stream: Stream::Stderr,
            chunk: format!("test channel error: {message}\n"),
            category: OutputCategory::Error,
            source_location: None,
        });
    }
    let (passed, failed, skipped) = state.summary.unwrap_or(state.counts);
    let _ = events.send(RunnerEvent::TestSummary {
        passed,
        failed,
        skipped,
        leaked: 0,
        duration_ms: execution.duration_ms,
    });
}
