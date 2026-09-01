//! Go runner mirrored from GoCompilerRunner.ts: instrument non-test .go
//! files, `go build ./generated`, execute, then `go test -json ./src`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::languages::packs;
use crate::protocol::{
    AppDiagnostic, Language, OutputCategory, RunResult, RunState, Severity, Stream, TestCase,
    TestStatus,
};
use crate::domain::session::{Session, SessionSettings, Snapshot};
use crate::exec::supervisor::{self, ProcessLimits, RunOptions, StreamCallbacks};

use crate::languages::common::{
    classify_execution, compile_failure_reason, dedupe_diagnostics, execute_program, instrument_files, truncate_chars,
    ExecuteConfig, InstrumentConfig,
};
use crate::languages::runtime::{cancelled_outcome, reset_generated, Events, RunnerEvent, RunnerOutcome, TerminalState};

const COMPILE_TIMEOUT_MS: u64 = 60_000;

fn go_env(root: &std::path::Path) -> Vec<(String, String)> {
    vec![
        (
            "GOCACHE".into(),
            root.join(".gocache").to_string_lossy().into_owned(),
        ),
        ("GOFLAGS".into(), "-mod=mod".into()),
        ("GOPROXY".into(), "off".into()),
        ("GO111MODULE".into(), "on".into()),
        ("CGO_ENABLED".into(), "0".into()),
    ]
}

pub fn discover_go_tests(files: &[crate::protocol::ProjectFile]) -> Vec<TestCase> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^func (Test[A-Za-z0-9_]*)\s*\(").expect("static"));
    let mut tests = Vec::new();
    for file in files {
        if !file.path.ends_with("_test.go") {
            continue;
        }
        for (index, line) in file.source.split('\n').enumerate() {
            let Some(capture) = re.captures(line) else {
                continue;
            };
            let name = capture.get(1).map(|m| m.as_str()).unwrap_or("");
            // TestMain is the harness hook, not a test: `go test` never
            // reports it, so a catalog row for it can only ever sit there
            // unreported (and get a phantom TimedOut on a suite timeout).
            if name == "TestMain" {
                continue;
            }
            tests.push(TestCase {
                test_id: format!("{}:{}", file.path, index + 1),
                path: format!("src/{}", file.path),
                name: name.to_string(),
                line: (index + 1) as u32,
                column: 1,
            });
        }
    }
    tests
}

fn go_project_path(file: &str) -> Option<String> {
    let normalized = file.replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("generated/") {
        return Some(format!("src/{rest}"));
    }
    if normalized.starts_with("src/") {
        return Some(normalized);
    }
    if let Some(index) = normalized.rfind("/generated/") {
        return Some(format!("src/{}", &normalized[index + "/generated/".len()..]));
    }
    if let Some(index) = normalized.rfind("/src/") {
        return Some(normalized[index + 1..].to_string());
    }
    None
}

pub fn parse_go_diagnostics(stderr: &str) -> Vec<AppDiagnostic> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"^(.+?\.go):(\d+)(?::(\d+))?: (.+)$").expect("static"));
    let mut diagnostics = Vec::new();
    for line in stderr.split('\n') {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let Some(capture) = re.captures(line.trim()) else {
            continue;
        };
        let file = capture.get(1).map(|m| m.as_str()).unwrap_or("");
        let line_number: u32 = capture
            .get(2)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(1);
        let column: u32 = capture
            .get(3)
            .and_then(|m| m.as_str().parse().ok())
            .unwrap_or(1);
        let message = capture.get(4).map(|m| m.as_str()).unwrap_or("");
        diagnostics.push(AppDiagnostic {
            message: message.to_string(),
            path: go_project_path(file),
            severity: Severity::Error,
            line: line_number,
            column,
            end_line: None,
            end_column: None,
            code: None,
            source: Some("go".to_string()),
        });
    }
    dedupe_diagnostics(diagnostics)
}

struct GoTestResult {
    name: String,
    status: TestStatus,
    duration_ms: f64,
    message: Option<String>,
}

fn parse_go_test_events(stdout: &str) -> Vec<GoTestResult> {
    static BANNER: OnceLock<Regex> = OnceLock::new();
    let banner = BANNER.get_or_init(|| {
        Regex::new(r"^(=== RUN|--- (FAIL|PASS|SKIP)|=== (PAUSE|CONT))").expect("static")
    });
    let mut output: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut results = Vec::new();
    for line in stdout.split('\n') {
        if !line.trim_start().starts_with('{') {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(test) = event.get("Test").and_then(Value::as_str) else {
            continue;
        };
        let action = event.get("Action").and_then(Value::as_str).unwrap_or("");
        if action == "output" {
            if let Some(text) = event.get("Output").and_then(Value::as_str) {
                if !banner.is_match(text.trim()) {
                    output
                        .entry(test.to_string())
                        .or_default()
                        .push(text.trim_end().to_string());
                }
            }
        } else if action == "pass" || action == "fail" || action == "skip" {
            let status = match action {
                "pass" => TestStatus::Passed,
                "fail" => TestStatus::Failed,
                _ => TestStatus::Skipped,
            };
            let message = if status == TestStatus::Failed {
                output.get(test).map(|lines| {
                    truncate_chars(
                        &lines
                            .iter()
                            .map(|item| item.trim())
                            .filter(|item| !item.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        1200,
                    )
                })
            } else {
                None
            };
            results.push(GoTestResult {
                name: test.to_string(),
                status,
                duration_ms: event.get("Elapsed").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0,
                message: message.filter(|m| !m.is_empty()),
            });
        }
    }
    results
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
    let test_catalog = discover_go_tests(&snapshot.files);
    emit(RunnerEvent::TestCatalog(test_catalog.clone()));
    let _ = reset_generated(&session.root).await;
    let instrumenter = packs::instrumenter_path(Language::Go);
    let outcome = instrument_files(
        session,
        snapshot,
        settings,
        &cancel,
        &events,
        InstrumentConfig {
            source_name: "golive-instrument",
            instruments: &|path| {
                path.to_lowercase().ends_with(".go") && !path.ends_with("_test.go")
            },
            command: instrumenter.to_string_lossy().into_owned(),
            command_prefix_args: Vec::new(),
            extra_args: &|_| Vec::new(),
            timeout_ms: 5000,
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

    emit(RunnerEvent::State(RunState::Compiling));
    let executable = session.root.join("target/go-bin");
    let _ = tokio::fs::create_dir_all(session.root.join("target")).await;
    let compile = supervisor::run(
        "go",
        &[
            "build".into(),
            "-o".into(),
            executable.to_string_lossy().into_owned(),
            "./generated".into(),
        ],
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 512 * 1024, 1024 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: go_env(&session.root),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    metrics.compilation_ms = compile.duration_ms;
    if compile.cancelled || cancel.is_cancelled() {
        return cancelled_outcome(metrics, "superseded");
    }
    let compile_diagnostics = parse_go_diagnostics(&compile.stderr);
    emit(RunnerEvent::Diagnostic {
        owner: "compiler".to_string(),
        diagnostics: compile_diagnostics.clone(),
    });
    if compile.exit_code != Some(0) || compile.limit.is_some() {
        if compile_diagnostics.is_empty() {
            emit(RunnerEvent::Output {
                stream: Stream::Stderr,
                chunk: compile.stderr.clone(),
                category: OutputCategory::Error,
                source_location: None,
            });
        }
        metrics.exit_code = compile.exit_code;
        metrics.signal = compile.signal.clone();
        metrics.timed_out = compile.timed_out;
        metrics.reason = Some(compile_failure_reason(&compile));
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::CompileError,
        };
    }

    emit(RunnerEvent::State(RunState::Running));
    let execution = execute_program(
        &outcome.probes,
        &outcome.file_ids,
        &cancel,
        &events,
        ExecuteConfig {
            sandbox: session.sandbox(settings),
            command: executable.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: session.root.join("src"),
            env: Vec::new(),
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
        static LOC: OnceLock<Regex> = OnceLock::new();
        let re = LOC.get_or_init(|| {
            Regex::new(r"(?:^|[\s\t])(?:.*[/\\])?(?:generated|src)[/\\]([\w./-]+\.go):(\d+)")
                .expect("static")
        });
        let location = re.captures(&result.stderr);
        emit(RunnerEvent::Diagnostic {
            owner: "runtime".to_string(),
            diagnostics: vec![AppDiagnostic {
                message: "Program panicked or exited abnormally".to_string(),
                path: location
                    .as_ref()
                    .and_then(|c| c.get(1))
                    .map(|m| format!("src/{}", m.as_str())),
                severity: Severity::Error,
                line: location
                    .as_ref()
                    .and_then(|c| c.get(2))
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(1),
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
    let execution = supervisor::run(
        "go",
        &[
            "test".into(),
            "-json".into(),
            "-count=1".into(),
            "-vet=off".into(),
            "./src".into(),
        ],
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(
                (settings.timeout_ms + COMPILE_TIMEOUT_MS).max(10_000),
                4 * 1024 * 1024,
                512 * 1024,
            ),
            cancel: cancel.clone(),
            probe_fd: false,
            env: go_env(&session.root),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    if execution.cancelled || cancel.is_cancelled() {
        return;
    }
    let results = parse_go_test_events(&execution.stdout);
    if results.is_empty() && execution.exit_code != Some(0) {
        let joined_output: String = execution
            .stdout
            .split('\n')
            .filter(|line| line.trim_start().starts_with('{'))
            .filter_map(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .and_then(|v| v.get("Output").and_then(Value::as_str).map(str::to_string))
            })
            .collect();
        let diagnostics =
            parse_go_diagnostics(&format!("{}\n{}", execution.stderr, joined_output));
        if diagnostics.is_empty() {
            let _ = events.send(RunnerEvent::Output {
                stream: Stream::Stderr,
                chunk: execution.stderr.clone(),
                category: OutputCategory::Error,
                source_location: None,
            });
        } else {
            let _ = events.send(RunnerEvent::Diagnostic {
                owner: "compiler".to_string(),
                diagnostics,
            });
        }
    }
    let mut counts = (0u32, 0u32, 0u32);
    let mut reported = std::collections::HashSet::new();
    for result in &results {
        match result.status {
            TestStatus::Passed => counts.0 += 1,
            TestStatus::Failed => counts.1 += 1,
            _ => counts.2 += 1,
        }
        // `t.Run` subtests report as `TestParent/case`; the catalog only
        // knows the parent (it is read off `func Test…` declarations), so
        // that is the row a subtest belongs to.
        let matched = catalog.iter().find(|c| c.name == result.name).or_else(|| {
            let parent = result.name.split('/').next().unwrap_or(&result.name);
            catalog.iter().find(|c| c.name == parent)
        });
        if let Some(matched) = matched {
            reported.insert(matched.test_id.clone());
        }
        let _ = events.send(RunnerEvent::TestResult {
            test_id: matched.map(|m| m.test_id.clone()),
            name: result.name.clone(),
            status: result.status,
            duration_ms: result.duration_ms,
            message: result.message.clone(),
        });
    }
    if execution.timed_out {
        for test in catalog {
            if reported.contains(&test.test_id) {
                continue;
            }
            counts.1 += 1;
            let _ = events.send(RunnerEvent::TestResult {
                test_id: Some(test.test_id.clone()),
                name: test.name.clone(),
                status: TestStatus::TimedOut,
                duration_ms: 0.0,
                message: None,
            });
        }
    }
    let _ = events.send(RunnerEvent::TestSummary {
        passed: counts.0,
        failed: counts.1,
        skipped: counts.2,
        leaked: 0,
        duration_ms: execution.duration_ms,
    });
}
