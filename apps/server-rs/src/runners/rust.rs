//! Rust runner mirrored from RustCompilerRunner.ts: instrument, cargo build
//! (JSON diagnostics), execute, then run libtest with --test-threads=1 and
//! fold its stdout into per-test results.

use std::sync::OnceLock;
use std::time::Instant;

use regex::Regex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::packs;
use crate::protocol::{
    AppDiagnostic, Language, OutputCategory, RunResult, RunState, Severity, Stream, TestCase,
    TestStatus,
};
use crate::session::{Session, SessionSettings, Snapshot};
use crate::supervisor::{self, ProcessLimits, RunOptions, StreamCallbacks};

use super::common::{
    classify_execution, dedupe_diagnostics, execute_program, instrument_files, truncate_chars,
    ExecuteConfig, InstrumentConfig,
};
use super::{cancelled_outcome, reset_generated, Events, RunnerEvent, RunnerOutcome, TerminalState};

const COMPILE_TIMEOUT_MS: u64 = 60_000;

fn cargo_env(root: &std::path::Path) -> Vec<(String, String)> {
    vec![
        ("CARGO_NET_OFFLINE".into(), "true".into()),
        (
            "CARGO_TARGET_DIR".into(),
            root.join("target").to_string_lossy().into_owned(),
        ),
        ("CARGO_TERM_COLOR".into(), "never".into()),
    ]
}

// ── test discovery (RustTestDiscovery.ts) ──

fn test_attr() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*#\[\s*(?:[A-Za-z_]\w*::)*test\b").expect("static"))
}

fn fn_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)").expect("static"))
}

fn other_attr() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*#\[").expect("static"))
}

pub fn discover_rust_tests(files: &[crate::protocol::ProjectFile]) -> Vec<TestCase> {
    let mut tests = Vec::new();
    for file in files {
        if !file.path.ends_with(".rs") {
            continue;
        }
        let lines: Vec<&str> = file.source.split('\n').collect();
        let mut index = 0;
        while index < lines.len() {
            if !test_attr().is_match(lines[index]) {
                index += 1;
                continue;
            }
            let mut advanced = false;
            for (lookahead, &line) in lines.iter().enumerate().skip(index + 1) {
                if let Some(capture) = fn_line().captures(line) {
                    let name = capture.get(1).map(|m| m.as_str()).unwrap_or_default();
                    let indent = line.len() - line.trim_start().len();
                    tests.push(TestCase {
                        test_id: format!("{}:{}", file.path, lookahead + 1),
                        path: format!("src/{}", file.path),
                        name: name.to_string(),
                        line: (lookahead + 1) as u32,
                        column: (indent + 1) as u32,
                    });
                    index = lookahead;
                    advanced = true;
                    break;
                }
                if !other_attr().is_match(line) && !line.trim().is_empty() {
                    break;
                }
            }
            let _ = advanced;
            index += 1;
        }
    }
    tests
}

pub fn match_rust_test_name<'a>(catalog: &'a [TestCase], runner_name: &str) -> Option<&'a TestCase> {
    let segments: Vec<&str> = runner_name.split("::").collect();
    let title = segments.last().copied().unwrap_or(runner_name);
    let modules = &segments[..segments.len().saturating_sub(1)];
    let by_title: Vec<&TestCase> = catalog.iter().filter(|c| c.name == title).collect();
    if by_title.len() <= 1 {
        return by_title.first().copied();
    }
    let mut scored: Vec<(&TestCase, usize)> = by_title
        .iter()
        .map(|candidate| {
            let stem: Vec<&str> = candidate
                .path
                .strip_prefix("src/")
                .unwrap_or(&candidate.path)
                .strip_suffix(".rs")
                .unwrap_or(&candidate.path)
                .split('/')
                .collect();
            let score = modules.iter().filter(|m| stem.contains(m)).count();
            (*candidate, score)
        })
        .collect();
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    scored.first().map(|(candidate, _)| *candidate)
}

// ── cargo JSON diagnostics (CargoDiagnostics.ts) ──

fn cargo_project_path(file_name: &str) -> Option<String> {
    let normalized = file_name.replace('\\', "/");
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

pub fn parse_cargo_diagnostics(stdout: &str) -> Vec<AppDiagnostic> {
    static ABORTING: OnceLock<Regex> = OnceLock::new();
    let aborting = ABORTING
        .get_or_init(|| Regex::new(r"aborting due to \d+ previous error").expect("static"));
    let mut diagnostics = Vec::new();
    for line in stdout.split('\n') {
        if !line.trim_start().starts_with('{') {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if parsed.get("reason").and_then(Value::as_str) != Some("compiler-message") {
            continue;
        }
        let Some(message) = parsed.get("message") else {
            continue;
        };
        let Some(text) = message.get("message").and_then(Value::as_str) else {
            continue;
        };
        let level = message.get("level").and_then(Value::as_str).unwrap_or("");
        let severity = if level == "error" || level.starts_with("error") {
            Severity::Error
        } else if level == "warning" {
            Severity::Warning
        } else {
            continue;
        };
        if aborting.is_match(text) {
            continue;
        }
        let spans = message.get("spans").and_then(Value::as_array);
        let primary = spans.and_then(|spans| {
            spans
                .iter()
                .find(|span| span.get("is_primary").and_then(Value::as_bool) == Some(true))
                .or_else(|| spans.first())
        });
        let Some(primary) = primary else { continue };
        let Some(file_name) = primary.get("file_name").and_then(Value::as_str) else {
            continue;
        };
        let Some(line_start) = primary.get("line_start").and_then(Value::as_u64) else {
            continue;
        };
        diagnostics.push(AppDiagnostic {
            message: text.to_string(),
            path: cargo_project_path(file_name),
            severity,
            line: line_start as u32,
            column: primary
                .get("column_start")
                .and_then(Value::as_u64)
                .unwrap_or(1) as u32,
            end_line: primary
                .get("line_end")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
            end_column: primary
                .get("column_end")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
            code: message
                .get("code")
                .and_then(|c| c.get("code"))
                .filter(|c| c.is_string())
                .cloned(),
            source: Some("rustc".to_string()),
        });
    }
    dedupe_diagnostics(diagnostics)
}

// ── libtest output (RustTestOutput.ts) ──

struct LibtestLine {
    name: String,
    status: String,
}

fn parse_libtest_line(line: &str) -> Option<LibtestLine> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^test (\S+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$").expect("static")
    });
    let capture = re.captures(line.trim())?;
    Some(LibtestLine {
        name: capture.get(1)?.as_str().to_string(),
        status: capture.get(2)?.as_str().to_string(),
    })
}

fn extract_failure_messages(stdout: &str) -> std::collections::HashMap<String, String> {
    // `---- name stdout ----` blocks end at the next block, `failures:` or
    // `note:` (the regex crate has no look-ahead; scan by lines instead).
    let mut messages = std::collections::HashMap::new();
    let lines: Vec<&str> = stdout.split('\n').collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let header = line
            .strip_prefix("---- ")
            .and_then(|rest| rest.strip_suffix(" stdout ----"));
        let Some(name) = header else {
            index += 1;
            continue;
        };
        let mut body = Vec::new();
        let mut cursor = index + 1;
        while cursor < lines.len() {
            let candidate = lines[cursor];
            if (candidate.starts_with("---- ") && candidate.ends_with(" stdout ----"))
                || candidate == "failures:"
                || candidate.starts_with("note:")
            {
                break;
            }
            body.push(candidate);
            cursor += 1;
        }
        messages.insert(
            name.to_string(),
            truncate_chars(body.join("\n").trim(), 1200),
        );
        index = cursor;
    }
    messages
}

fn parse_libtest_summary(stdout: &str) -> Option<(u32, u32, u32)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored")
            .expect("static")
    });
    let capture = re.captures(stdout)?;
    Some((
        capture.get(1)?.as_str().parse().ok()?,
        capture.get(2)?.as_str().parse().ok()?,
        capture.get(3)?.as_str().parse().ok()?,
    ))
}

fn find_test_executable(stdout: &str, target_name: &str) -> Option<String> {
    let mut executable = None;
    for line in stdout.split('\n') {
        if !line.trim_start().starts_with('{') {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if parsed.get("reason").and_then(Value::as_str) == Some("compiler-artifact")
            && parsed
                .get("profile")
                .and_then(|p| p.get("test"))
                .and_then(Value::as_bool)
                == Some(true)
            && parsed
                .get("target")
                .and_then(|t| t.get("name"))
                .and_then(Value::as_str)
                == Some(target_name)
        {
            if let Some(path) = parsed.get("executable").and_then(Value::as_str) {
                executable = Some(path.to_string());
            }
        }
    }
    executable
}

// ── runner ──

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
    let test_catalog = discover_rust_tests(&snapshot.files);
    emit(RunnerEvent::TestCatalog(test_catalog.clone()));
    let _ = reset_generated(&session.root).await;
    let instrumenter = packs::instrumenter_path(Language::Rust);
    let outcome = instrument_files(
        session,
        snapshot,
        settings,
        &cancel,
        &events,
        InstrumentConfig {
            source_name: "rustlive-instrument",
            instruments: &|path| path.to_lowercase().ends_with(".rs"),
            command: instrumenter.to_string_lossy().into_owned(),
            command_prefix_args: Vec::new(),
            extra_args: &|path| {
                if path == "main.rs" {
                    vec!["--entry".to_string()]
                } else {
                    Vec::new()
                }
            },
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
    let compile = supervisor::run(
        "cargo",
        &[
            "build".into(),
            "--bin".into(),
            "atomis-session".into(),
            "--message-format=json".into(),
            "--quiet".into(),
            "--offline".into(),
        ],
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 8 * 1024 * 1024, 512 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: cargo_env(&session.root),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    metrics.compilation_ms = compile.duration_ms;
    if compile.cancelled || cancel.is_cancelled() {
        return cancelled_outcome(metrics, "superseded");
    }
    let compile_diagnostics = parse_cargo_diagnostics(&compile.stdout);
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
        metrics.reason = Some(match compile.limit {
            Some(limit) => format!("{limit} output limit exceeded"),
            None => "compiler error".to_string(),
        });
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::CompileError,
        };
    }

    emit(RunnerEvent::State(RunState::Running));
    let executable = session.root.join("target/debug/atomis-session");
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
        static PANIC_RE: OnceLock<Regex> = OnceLock::new();
        let re = PANIC_RE.get_or_init(|| {
            Regex::new(r"panicked at (?:.*[/\\])?(?:generated|src)[/\\](.+?\.rs):(\d+):(\d+)")
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
    let build = supervisor::run(
        "cargo",
        &[
            "test".into(),
            "--bin".into(),
            "atomis-check".into(),
            "--no-run".into(),
            "--message-format=json".into(),
            "--quiet".into(),
            "--offline".into(),
        ],
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 8 * 1024 * 1024, 512 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: cargo_env(&session.root),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    if build.cancelled || cancel.is_cancelled() {
        return;
    }
    if build.exit_code != Some(0) {
        let diagnostics = parse_cargo_diagnostics(&build.stdout);
        if diagnostics.is_empty() {
            let _ = events.send(RunnerEvent::Output {
                stream: Stream::Stderr,
                chunk: build.stderr.clone(),
                category: OutputCategory::Error,
                source_location: None,
            });
        } else {
            let _ = events.send(RunnerEvent::Diagnostic {
                owner: "compiler".to_string(),
                diagnostics,
            });
        }
        let _ = events.send(RunnerEvent::TestSummary {
            passed: 0,
            failed: 0,
            skipped: 0,
            leaked: 0,
            duration_ms: build.duration_ms,
        });
        return;
    }
    let Some(executable) = find_test_executable(&build.stdout, "atomis-check") else {
        let _ = events.send(RunnerEvent::Output {
            stream: Stream::Stderr,
            chunk: "test binary not found in cargo output\n".to_string(),
            category: OutputCategory::Error,
            source_location: None,
        });
        return;
    };

    let started = Instant::now();
    let arrivals: std::sync::Mutex<Vec<(String, String, f64)>> = std::sync::Mutex::new(Vec::new());
    let mut full_stdout = String::new();
    let execution = {
        let arrivals = &arrivals;
        let full = &mut full_stdout;
        let mut buffer = String::new();
        supervisor::run(
            &executable,
            &["--test-threads=1".into()],
            RunOptions {
                cwd: session.root.join("src"),
                limits: ProcessLimits::new(
                    settings.timeout_ms.max(3000),
                    1024 * 1024,
                    512 * 1024,
                ),
                cancel: cancel.clone(),
                probe_fd: false,
                env: Vec::new(),
                sandbox: session.sandbox(settings),
                callbacks: StreamCallbacks {
                    stdout: Some(Box::new(move |chunk: &str| {
                        full.push_str(chunk);
                        buffer.push_str(chunk);
                        while let Some(newline) = buffer.find('\n') {
                            let line: String = buffer.drain(..=newline).collect();
                            if let Some(parsed) = parse_libtest_line(line.trim_end_matches('\n')) {
                                arrivals.lock().expect("arrivals").push((
                                    parsed.name,
                                    parsed.status,
                                    started.elapsed().as_secs_f64() * 1000.0,
                                ));
                            }
                        }
                    })),
                    stderr: None,
                    probe: None,
                },
            },
        )
        .await
    };
    if execution.cancelled || cancel.is_cancelled() {
        return;
    }
    let messages = extract_failure_messages(&full_stdout);
    let mut reported = std::collections::HashSet::new();
    let mut previous = 0.0f64;
    let mut counts = (0u32, 0u32, 0u32); // passed, failed, skipped
    for (name, status, at) in arrivals.lock().expect("arrivals").iter() {
        let matched = match_rust_test_name(catalog, name);
        if let Some(matched) = matched {
            reported.insert(matched.test_id.clone());
        }
        let test_status = match status.as_str() {
            "ok" => {
                counts.0 += 1;
                TestStatus::Passed
            }
            "ignored" => {
                counts.2 += 1;
                TestStatus::Skipped
            }
            _ => {
                counts.1 += 1;
                TestStatus::Failed
            }
        };
        let message = if test_status == TestStatus::Failed {
            messages.get(name).cloned()
        } else {
            None
        };
        let _ = events.send(RunnerEvent::TestResult {
            test_id: matched.map(|m| m.test_id.clone()),
            name: matched.map(|m| m.name.clone()).unwrap_or_else(|| name.clone()),
            status: test_status,
            duration_ms: (at - previous).max(0.0),
            message,
        });
        previous = *at;
    }
    if execution.timed_out || execution.exit_code.is_none() {
        for test in catalog {
            if reported.contains(&test.test_id) {
                continue;
            }
            counts.1 += 1;
            let _ = events.send(RunnerEvent::TestResult {
                test_id: Some(test.test_id.clone()),
                name: test.name.clone(),
                status: if execution.timed_out {
                    TestStatus::TimedOut
                } else {
                    TestStatus::Failed
                },
                duration_ms: 0.0,
                message: None,
            });
        }
    }
    let summary = parse_libtest_summary(&full_stdout);
    let _ = events.send(RunnerEvent::TestSummary {
        passed: summary.map(|s| s.0).unwrap_or(counts.0),
        failed: match summary {
            Some(s) if !execution.timed_out => s.1,
            _ => counts.1,
        },
        skipped: summary.map(|s| s.2).unwrap_or(counts.2),
        leaked: 0,
        duration_ms: execution.duration_ms,
    });
}
