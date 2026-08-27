//! Zig runner mirrored from CompilerRunner.ts: instrument every .zig file,
//! compile `zig build instrumented [tests]`, execute with probe fd 3 and
//! marker-parsed stderr, then run the custom test runner.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::markers::MarkerParser;
use crate::ndjson::{ProbeReader, RawTestEvent, RawTestStatus, TestReader};
use crate::packs;
use crate::protocol::{
    AppDiagnostic, Language, OutputCategory, ProbeDescriptor, RunResult, RunState, Severity,
    Stream, TestCase, TestStatus,
};
use crate::session::{Session, SessionSettings, Snapshot};
use crate::supervisor::{self, ProcessLimits, RunOptions, StreamCallbacks};

use super::{
    cancelled_outcome, reset_generated, Events, InstrumentationOutput, ProbeForwarder,
    RunnerEvent, RunnerOutcome, TerminalState,
};
use super::zig_diag::{discover_tests, match_runner_name, parse_compiler_diagnostics};

fn instrument_error(path: &str, message: &str) -> AppDiagnostic {
    AppDiagnostic {
        message: message.to_string(),
        path: Some(format!("src/{path}")),
        severity: Severity::Error,
        line: 1,
        column: 1,
        end_line: None,
        end_column: None,
        code: None,
        source: Some("runzig-instrument".to_string()),
    }
}

pub async fn run(
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> RunnerOutcome {
    let generated_path = session.root.join("generated").join("main.zig");
    let generated_path_str = generated_path.to_string_lossy().to_string();
    let mut metrics = RunResult::default();
    let emit = |event: RunnerEvent| {
        let _ = events.send(event);
    };

    emit(RunnerEvent::State(RunState::Instrumenting));
    let test_catalog = discover_tests(&snapshot.files);
    emit(RunnerEvent::TestCatalog(test_catalog.clone()));
    let test_imports: String = snapshot
        .files
        .iter()
        .filter(|f| f.path.to_lowercase().ends_with(".zig"))
        .map(|f| format!("    _ = @import(\"src/{}\");\n", f.path.replace('"', "\\\"")))
        .collect();
    if tokio::fs::write(
        session.root.join("test_root.zig"),
        format!("comptime {{\n{test_imports}}}\n"),
    )
    .await
    .is_err()
    {
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::CompileError,
        };
    }
    let _ = reset_generated(&session.root).await;

    let mut probes: Vec<ProbeDescriptor> = Vec::new();
    let mut instrument_diagnostics: Vec<AppDiagnostic> = Vec::new();
    let mut file_ids: HashMap<u32, String> = HashMap::new();
    let mut file_id: u32 = 0;
    let instrumenter = packs::instrumenter_path(Language::Zig);
    for file in &snapshot.files {
        let source_path = session.root.join("src").join(&file.path);
        let output_path = session.root.join("generated").join(&file.path);
        if let Some(parent) = output_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if !file.path.to_lowercase().ends_with(".zig") {
            let _ = tokio::fs::copy(&source_path, &output_path).await;
            continue;
        }
        file_id += 1;
        file_ids.insert(file_id, format!("src/{}", file.path));
        let source_map_path = session
            .root
            .join("generated")
            .join(format!(".ziglive-{file_id}.json"));
        let mut args: Vec<String> = vec![
            "--input".into(),
            source_path.to_string_lossy().into_owned(),
            "--output".into(),
            output_path.to_string_lossy().into_owned(),
            "--source-map".into(),
            source_map_path.to_string_lossy().into_owned(),
            "--uri".into(),
            file.uri.clone(),
            "--version".into(),
            snapshot.version.to_string(),
            "--file-id".into(),
            file_id.to_string(),
        ];
        if !settings.auto_inspect {
            args.push("--no-auto-inspect".into());
        }
        for id in &settings.manual_probe_ids {
            args.push("--manual".into());
            args.push(id.clone());
        }
        let instrument = supervisor::run(
            &instrumenter.to_string_lossy(),
            &args,
            RunOptions {
                cwd: session.root.clone(),
                limits: ProcessLimits::new(5000, 1024 * 1024, 512 * 1024),
                cancel: cancel.clone(),
                probe_fd: false,
                env: Vec::new(),
                callbacks: StreamCallbacks::default(),
            },
        )
        .await;
        metrics.instrumentation_ms += instrument.duration_ms;
        if instrument.cancelled || cancel.is_cancelled() {
            return cancelled_outcome(metrics, "superseded");
        }
        if instrument.exit_code != Some(0) {
            emit(RunnerEvent::Output {
                stream: Stream::Stderr,
                chunk: instrument.stderr.clone(),
                category: OutputCategory::Error,
                source_location: None,
            });
            instrument_diagnostics.push(instrument_error(&file.path, "Instrumentation failed"));
            continue;
        }
        let metadata: InstrumentationOutput = match serde_json::from_str(&instrument.stdout) {
            Ok(metadata) => metadata,
            Err(error) => {
                instrument_diagnostics.push(instrument_error(
                    &file.path,
                    &format!("Invalid instrumenter response: {error}"),
                ));
                continue;
            }
        };
        if metadata.protocol_version != 1 || metadata.document_version != snapshot.version {
            instrument_diagnostics.push(instrument_error(
                &file.path,
                "Instrumenter protocol/version mismatch",
            ));
            continue;
        }
        probes.extend(metadata.probes.into_iter().map(|mut probe| {
            probe.path = Some(format!("src/{}", file.path));
            probe
        }));
        if metadata.generated_path.is_none() {
            instrument_diagnostics.extend(metadata.parse_diagnostics.into_iter().map(|item| {
                AppDiagnostic {
                    message: item.message,
                    path: Some(format!("src/{}", file.path)),
                    severity: Severity::Error,
                    line: item.line.unwrap_or(1),
                    column: item.column.unwrap_or(1),
                    end_line: None,
                    end_column: None,
                    code: None,
                    source: Some("runzig-instrument".to_string()),
                }
            }));
        }
    }
    *session.probes.lock().await = probes.clone();
    emit(RunnerEvent::Catalog(probes.clone()));
    emit(RunnerEvent::Diagnostic {
        owner: "ziglive-instrumenter".to_string(),
        diagnostics: instrument_diagnostics.clone(),
    });
    if !instrument_diagnostics.is_empty() {
        metrics.reason = Some("instrumentation error".to_string());
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::CompileError,
        };
    }

    emit(RunnerEvent::State(RunState::Compiling));
    let mut compile_args: Vec<String> = vec!["build".into(), "instrumented".into()];
    if !test_catalog.is_empty() {
        compile_args.push("tests".into());
    }
    compile_args.push("--color".into());
    compile_args.push("off".into());
    let compile_events = events.clone();
    let compile = supervisor::run(
        "zig",
        &compile_args,
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(30_000, 512 * 1024, 512 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: Vec::new(),
            callbacks: StreamCallbacks {
                stdout: Some(Box::new({
                    let events = compile_events.clone();
                    move |chunk: &str| {
                        let _ = events.send(RunnerEvent::Output {
                            stream: Stream::Stdout,
                            chunk: chunk.to_string(),
                            category: OutputCategory::Program,
                            source_location: None,
                        });
                    }
                })),
                stderr: Some(Box::new({
                    let events = compile_events.clone();
                    move |chunk: &str| {
                        let _ = events.send(RunnerEvent::Output {
                            stream: Stream::Stderr,
                            chunk: chunk.to_string(),
                            category: OutputCategory::Error,
                            source_location: None,
                        });
                    }
                })),
                probe: None,
            },
        },
    )
    .await;
    metrics.compilation_ms = compile.duration_ms;
    if compile.cancelled || cancel.is_cancelled() {
        return cancelled_outcome(metrics, "superseded");
    }
    if compile.exit_code != Some(0) || compile.limit.is_some() {
        emit(RunnerEvent::Diagnostic {
            owner: "compiler".to_string(),
            diagnostics: parse_compiler_diagnostics(&compile.stderr, &generated_path_str),
        });
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
    emit(RunnerEvent::Diagnostic {
        owner: "compiler".to_string(),
        diagnostics: Vec::new(),
    });

    emit(RunnerEvent::State(RunState::Running));
    let mut forwarder = ProbeForwarder::new(&probes, events.clone());
    let marker_events = events.clone();
    let mut stderr_parser = MarkerParser::new(
        Stream::Stderr,
        true,
        file_ids.clone(),
        Box::new(move |stream, chunk, category, location| {
            let _ = marker_events.send(RunnerEvent::Output {
                stream,
                chunk: chunk.to_string(),
                category,
                source_location: location,
            });
        }),
    );
    let executable = session.root.join("zig-out/bin/ziglive-session");
    let run_events = events.clone();
    let execution = {
        let forwarder = &mut forwarder;
        let mut probe_reader = ProbeReader::new(Box::new(move |event| forwarder.forward(event)));
        let parser = &mut stderr_parser;
        let reader = &mut probe_reader;
        let execution = supervisor::run(
            &executable.to_string_lossy(),
            &[],
            RunOptions {
                cwd: session.root.join("src"),
                limits: ProcessLimits::new(settings.timeout_ms, 512 * 1024, 512 * 1024),
                cancel: cancel.clone(),
                probe_fd: true,
                env: Vec::new(),
                callbacks: StreamCallbacks {
                    stdout: Some(Box::new({
                        let events = run_events.clone();
                        move |chunk: &str| {
                            let _ = events.send(RunnerEvent::Output {
                                stream: Stream::Stdout,
                                chunk: chunk.to_string(),
                                category: OutputCategory::Program,
                                source_location: None,
                            });
                        }
                    })),
                    stderr: Some(Box::new(move |chunk: &str| parser.push(chunk))),
                    probe: Some(Box::new(move |chunk: &[u8]| reader.push(chunk))),
                },
            },
        )
        .await;
        probe_reader.end();
        (execution, probe_reader.error.clone())
    };
    let (execution, mut probe_error) = execution;
    stderr_parser.flush();
    metrics.execution_ms = execution.duration_ms;
    metrics.exit_code = execution.exit_code;
    metrics.signal = execution.signal.clone();
    metrics.timed_out = execution.timed_out;
    metrics.cancelled = execution.cancelled;
    let _ = &mut probe_error;
    if execution.cancelled || cancel.is_cancelled() {
        metrics.reason = Some("cancelled".to_string());
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::Cancelled,
        };
    }
    if execution.timed_out {
        metrics.reason = Some("execution timeout".to_string());
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::TimedOut,
        };
    }
    if execution.limit.is_some() || probe_error.is_some() {
        metrics.reason = Some(
            probe_error
                .unwrap_or_else(|| format!("{} limit exceeded", execution.limit.unwrap_or("runtime"))),
        );
        return RunnerOutcome {
            result: metrics,
            terminal_state: TerminalState::RuntimeError,
        };
    }
    if execution.exit_code != Some(0) || execution.signal.is_some() {
        let location = find_runtime_location(&execution.stderr, &generated_path_str);
        emit(RunnerEvent::Diagnostic {
            owner: "runtime".to_string(),
            diagnostics: vec![AppDiagnostic {
                message: "Program panicked or exited abnormally".to_string(),
                path: None,
                severity: Severity::Error,
                line: location.map(|l| l.0).unwrap_or(1),
                column: location.map(|l| l.1).unwrap_or(1),
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

fn find_runtime_location(stderr: &str, generated_path: &str) -> Option<(u32, u32)> {
    let needle = format!("{generated_path}:");
    let index = stderr.find(&needle)?;
    let rest = &stderr[index + needle.len()..];
    let line: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let rest = rest.strip_prefix(&line)?.strip_prefix(':')?;
    let column: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    Some((line.parse().ok()?, column.parse().ok()?))
}

struct TestRunState {
    started: HashMap<u32, String>,
    counts: (u32, u32, u32, u32),
    stderr_buffer: String,
    summary: Option<(u32, u32, u32, u32)>,
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
    let state = Arc::new(Mutex::new(TestRunState {
        started: HashMap::new(),
        counts: (0, 0, 0, 0),
        stderr_buffer: String::new(),
        summary: None,
    }));
    let read_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let reader_state = Arc::clone(&state);
    let reader_events = events.clone();
    let catalog_owned = catalog.to_vec();
    let mut reader = TestReader::new(Box::new(move |event| {
        let mut state = reader_state.lock().expect("test state");
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
                match status {
                    RawTestStatus::Passed => state.counts.0 += 1,
                    RawTestStatus::Failed => state.counts.1 += 1,
                    RawTestStatus::Skipped => state.counts.2 += 1,
                    RawTestStatus::Leaked => state.counts.3 += 1,
                }
                let matched = match_runner_name(&catalog_owned, &name);
                let failing =
                    matches!(status, RawTestStatus::Failed | RawTestStatus::Leaked);
                let tail = state.stderr_buffer.trim().to_string();
                let message = if failing {
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
                    status: match status {
                        RawTestStatus::Passed => TestStatus::Passed,
                        RawTestStatus::Failed => TestStatus::Failed,
                        RawTestStatus::Skipped => TestStatus::Skipped,
                        RawTestStatus::Leaked => TestStatus::Leaked,
                    },
                    duration_ms: duration_ns / 1_000_000.0,
                    message,
                });
                state.stderr_buffer.clear();
            }
            RawTestEvent::TestSummary {
                passed,
                failed,
                skipped,
                leaked,
            } => {
                state.summary = Some((passed, failed, skipped, leaked));
            }
        }
    }));

    let executable = session.root.join("zig-out/bin/ziglive-tests");
    let stderr_state = Arc::clone(&state);
    let execution = supervisor::run(
        &executable.to_string_lossy(),
        &[],
        RunOptions {
            cwd: session.root.join("src"),
            limits: ProcessLimits::new(settings.timeout_ms.max(3000), 512 * 1024, 512 * 1024),
            cancel: cancel.clone(),
            probe_fd: true,
            env: Vec::new(),
            callbacks: StreamCallbacks {
                stdout: None,
                stderr: Some(Box::new(move |chunk: &str| {
                    stderr_state
                        .lock()
                        .expect("test stderr")
                        .stderr_buffer
                        .push_str(chunk);
                })),
                probe: Some(Box::new({
                    let error = Arc::clone(&read_error);
                    move |chunk: &[u8]| {
                        reader.push(chunk);
                        if let Some(message) = reader.error.clone() {
                            error.lock().expect("read error").get_or_insert(message);
                        }
                    }
                })),
            },
        },
    )
    .await;
    if execution.cancelled || cancel.is_cancelled() {
        return;
    }
    let mut state = state.lock().expect("test state");
    let started: Vec<String> = state.started.values().cloned().collect();
    for name in started {
        state.counts.1 += 1;
        let matched = match_runner_name(catalog, &name);
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
    if let Some(message) = read_error.lock().expect("read error").clone() {
        let _ = events.send(RunnerEvent::Output {
            stream: Stream::Stderr,
            chunk: format!("test channel error: {message}\n"),
            category: OutputCategory::Error,
            source_location: None,
        });
    }
    let (passed, failed, skipped, leaked) = state.summary.unwrap_or(state.counts);
    let _ = events.send(RunnerEvent::TestSummary {
        passed,
        failed,
        skipped,
        leaked,
        duration_ms: execution.duration_ms,
    });
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
