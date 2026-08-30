//! TS/JS runner mirrored from TsCompilerRunner.ts: instrument via node,
//! non-blocking tsc typecheck, run with `node --import runtime`, tests via
//! `node --test --test-reporter=tap`.

use std::sync::OnceLock;

use regex::Regex;
use tokio_util::sync::CancellationToken;

use crate::languages::packs;
use crate::protocol::{
    AppDiagnostic, Language, OutputCategory, RunResult, RunState, Severity, Stream, TestCase,
    TestStatus,
};
use crate::domain::session::{Session, SessionSettings, Snapshot};
use crate::exec::supervisor::{self, ProcessLimits, RunOptions, StreamCallbacks};

use crate::languages::common::{
    classify_execution, dedupe_diagnostics, execute_program, instrument_files, truncate_chars,
    ExecuteConfig, InstrumentConfig,
};
use crate::languages::runtime::{cancelled_outcome, reset_generated, Events, RunnerEvent, RunnerOutcome, TerminalState};

const TSC_TIMEOUT_MS: u64 = 60_000;

fn is_code(path: &str) -> bool {
    path.ends_with(".ts") || path.ends_with(".js") || path.ends_with(".mjs")
}

pub fn is_test_file(path: &str) -> bool {
    path.ends_with(".test.ts") || path.ends_with(".test.js") || path.ends_with(".test.mjs")
}

pub fn discover_ts_tests(files: &[crate::protocol::ProjectFile]) -> Vec<TestCase> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"^\s*(?:test|it)\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)"#)
            .expect("static")
    });
    let mut tests = Vec::new();
    for file in files {
        if !is_test_file(&file.path) {
            continue;
        }
        for (index, line) in file.source.split('\n').enumerate() {
            let Some(capture) = re.captures(line) else {
                continue;
            };
            let raw = capture.get(1).map(|m| m.as_str()).unwrap_or("\"\"");
            let inner = &raw[1..raw.len() - 1];
            let mut name = String::new();
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(next) = chars.next() {
                        name.push(next);
                    }
                } else {
                    name.push(c);
                }
            }
            let indent = line.len() - line.trim_start().len();
            tests.push(TestCase {
                test_id: format!("{}:{}", file.path, index + 1),
                path: format!("src/{}", file.path),
                name,
                line: (index + 1) as u32,
                column: (indent + 1) as u32,
            });
        }
    }
    tests
}

struct TapResult {
    name: String,
    status: TestStatus,
    duration_ms: f64,
    message: Option<String>,
}

fn parse_tap_output(stdout: &str) -> Vec<TapResult> {
    static RESULT: OnceLock<Regex> = OnceLock::new();
    let result_re = RESULT.get_or_init(|| {
        Regex::new(r"^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO).*)?$").expect("static")
    });
    static DURATION: OnceLock<Regex> = OnceLock::new();
    let duration_re =
        DURATION.get_or_init(|| Regex::new(r"^\s*duration_ms:\s*([\d.]+)").expect("static"));
    static ERROR_HEAD: OnceLock<Regex> = OnceLock::new();
    let error_re = ERROR_HEAD.get_or_init(|| Regex::new(r"^\s*error: \|-?$").expect("static"));

    let lines: Vec<&str> = stdout.split('\n').collect();
    let mut results = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(capture) = result_re.captures(line) else {
            continue;
        };
        let name = capture.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
        let status = if capture.get(3).is_some() {
            TestStatus::Skipped
        } else if capture.get(1).is_some() {
            TestStatus::Failed
        } else {
            TestStatus::Passed
        };
        let mut duration_ms = 0.0;
        let mut message: Option<String> = None;
        for cursor in index + 1..lines.len() {
            let inner = lines[cursor];
            if !inner.starts_with("  ") {
                break;
            }
            if inner.trim() == "..." {
                break;
            }
            if let Some(duration) = duration_re.captures(inner) {
                if let Some(value) = duration.get(1).and_then(|m| m.as_str().parse().ok()) {
                    duration_ms = value;
                }
            }
            if error_re.is_match(inner) {
                let indent = inner.len() - inner.trim_start().len() + 2;
                let mut collected: Vec<String> = Vec::new();
                for &body_line in lines.iter().skip(cursor + 1) {
                    if body_line.trim().is_empty() && !collected.is_empty() {
                        collected.push(String::new());
                        continue;
                    }
                    let body_indent = body_line.len() - body_line.trim_start().len();
                    if body_indent < indent {
                        break;
                    }
                    collected.push(
                        body_line
                            .get(indent..)
                            .unwrap_or(body_line.trim_start())
                            .to_string(),
                    );
                }
                message = Some(truncate_chars(collected.join("\n").trim(), 1200));
            }
        }
        results.push(TapResult {
            name,
            status,
            duration_ms,
            message: if status == TestStatus::Failed {
                message.filter(|m| !m.is_empty())
            } else {
                None
            },
        });
    }
    results
}

pub fn parse_tsc_diagnostics(output: &str) -> Vec<AppDiagnostic> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$").expect("static")
    });
    let mut diagnostics = Vec::new();
    for line in output.split('\n') {
        let Some(capture) = re.captures(line.trim()) else {
            continue;
        };
        let mut normalized = capture
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .replace('\\', "/");
        if let Some(marker) = normalized.rfind("/src/") {
            normalized = normalized[marker + 1..].to_string();
        }
        if !normalized.starts_with("src/") {
            continue;
        }
        diagnostics.push(AppDiagnostic {
            message: capture.get(5).map(|m| m.as_str()).unwrap_or("").to_string(),
            path: Some(normalized),
            severity: if capture.get(4).map(|m| m.as_str()) == Some("warning") {
                Severity::Warning
            } else {
                Severity::Error
            },
            line: capture
                .get(2)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(1),
            column: capture
                .get(3)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(1),
            end_line: None,
            end_column: None,
            code: None,
            source: Some("tsc".to_string()),
        });
    }
    dedupe_diagnostics(diagnostics)
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
    let test_catalog = discover_ts_tests(&snapshot.files);
    emit(RunnerEvent::TestCatalog(test_catalog.clone()));
    let _ = reset_generated(&session.root).await;
    let instrumenter = packs::instrumenter_path(Language::Ts);
    let outcome = instrument_files(
        session,
        snapshot,
        settings,
        &cancel,
        &events,
        InstrumentConfig {
            source_name: "tslive-instrument",
            instruments: &|path| is_code(path) && !is_test_file(path),
            command: "node".to_string(),
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

    // Type checking surfaces diagnostics but never blocks the run: node
    // strips types regardless, matching the language's semantics.
    emit(RunnerEvent::State(RunState::Compiling));
    let tsc_entry = packs::project_root().join("node_modules/typescript/bin/tsc");
    let typecheck = supervisor::run(
        "node",
        &[
            tsc_entry.to_string_lossy().into_owned(),
            "-p".into(),
            session.root.join("tsconfig.json").to_string_lossy().into_owned(),
            "--pretty".into(),
            "false".into(),
        ],
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(TSC_TIMEOUT_MS, 2 * 1024 * 1024, 512 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: Vec::new(),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    metrics.compilation_ms = typecheck.duration_ms;
    if typecheck.cancelled || cancel.is_cancelled() {
        return cancelled_outcome(metrics, "superseded");
    }
    emit(RunnerEvent::Diagnostic {
        owner: "compiler".to_string(),
        diagnostics: parse_tsc_diagnostics(&format!(
            "{}\n{}",
            typecheck.stdout, typecheck.stderr
        )),
    });

    emit(RunnerEvent::State(RunState::Running));
    let runtime_module = session.root.join("generated/__atomis_runtime.mjs");
    let entry = session.root.join("generated/main.ts");
    let execution = execute_program(
        &outcome.probes,
        &outcome.file_ids,
        &cancel,
        &events,
        ExecuteConfig {
            sandbox: session.sandbox(settings),
            command: "node".to_string(),
            args: vec![
                "--import".into(),
                format!("file://{}", runtime_module.to_string_lossy()),
                entry.to_string_lossy().into_owned(),
            ],
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
            Regex::new(r"(?:generated|src)[/\\]([\w./-]+\.(?:ts|js|mjs|cjs)):(\d+)(?::(\d+))?")
                .expect("static")
        });
        let location = re.captures(&result.stderr);
        emit(RunnerEvent::Diagnostic {
            owner: "runtime".to_string(),
            diagnostics: vec![AppDiagnostic {
                message: "Program threw or exited abnormally".to_string(),
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
                column: location
                    .as_ref()
                    .and_then(|c| c.get(3))
                    .and_then(|m| m.as_str().parse().ok())
                    .unwrap_or(1),
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
    let mut test_files: Vec<String> = Vec::new();
    for test in catalog {
        let path = session.root.join(&test.path).to_string_lossy().into_owned();
        if !test_files.contains(&path) {
            test_files.push(path);
        }
    }
    let mut args: Vec<String> = vec!["--test".into(), "--test-reporter=tap".into()];
    args.extend(test_files);
    let execution = supervisor::run(
        "node",
        &args,
        RunOptions {
            cwd: session.root.join("src"),
            limits: ProcessLimits::new(
                (settings.timeout_ms + 5000).max(10_000),
                2 * 1024 * 1024,
                512 * 1024,
            ),
            cancel: cancel.clone(),
            probe_fd: false,
            env: Vec::new(),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    if execution.cancelled || cancel.is_cancelled() {
        return;
    }
    let results = parse_tap_output(&execution.stdout);
    if results.is_empty() && execution.exit_code != Some(0) {
        let _ = events.send(RunnerEvent::Output {
            stream: Stream::Stderr,
            chunk: execution.stderr.clone(),
            category: OutputCategory::Error,
            source_location: None,
        });
    }
    let mut counts = (0u32, 0u32, 0u32);
    let mut reported = std::collections::HashSet::new();
    for result in &results {
        match result.status {
            TestStatus::Passed => counts.0 += 1,
            TestStatus::Failed => counts.1 += 1,
            _ => counts.2 += 1,
        }
        let matched = catalog.iter().find(|c| c.name == result.name);
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
