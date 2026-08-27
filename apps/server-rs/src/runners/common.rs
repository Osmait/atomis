//! Shared runner phases: the per-file instrumentation loop (identical across
//! languages in the Node server) and the instrumented-program execution with
//! marker parsing + probe NDJSON.

use std::collections::HashMap;

use tokio_util::sync::CancellationToken;

use crate::markers::MarkerParser;
use crate::ndjson::ProbeReader;
use crate::protocol::{
    AppDiagnostic, OutputCategory, ProbeDescriptor, RunResult, Severity, Stream,
};
use crate::session::{Session, SessionSettings, Snapshot};
use crate::supervisor::{self, ProcessLimits, ProcessResult, RunOptions, StreamCallbacks};

use super::{Events, InstrumentationOutput, ProbeForwarder, RunnerEvent};

pub struct InstrumentConfig<'a> {
    /// Diagnostic `source` name, e.g. "runzig-instrument".
    pub source_name: &'static str,
    /// Files matching are instrumented; others are copied verbatim.
    pub instruments: &'a (dyn Fn(&str) -> bool + Sync),
    /// Command to spawn: e.g. `(instrumenter, [])` or `("node", [script])`.
    pub command: String,
    pub command_prefix_args: Vec<String>,
    /// Extra per-file flags (e.g. `--entry` for main.rs, `--lang c`).
    pub extra_args: &'a (dyn Fn(&str) -> Vec<String> + Sync),
    pub timeout_ms: u64,
}

pub struct InstrumentOutcome {
    pub probes: Vec<ProbeDescriptor>,
    pub diagnostics: Vec<AppDiagnostic>,
    pub file_ids: HashMap<u32, String>,
    pub cancelled: bool,
    pub duration_ms: f64,
}

fn instrument_error(source_name: &str, path: &str, message: &str) -> AppDiagnostic {
    AppDiagnostic {
        message: message.to_string(),
        path: Some(format!("src/{path}")),
        severity: Severity::Error,
        line: 1,
        column: 1,
        end_line: None,
        end_column: None,
        code: None,
        source: Some(source_name.to_string()),
    }
}

pub async fn instrument_files(
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    cancel: &CancellationToken,
    events: &Events,
    config: InstrumentConfig<'_>,
) -> InstrumentOutcome {
    let mut outcome = InstrumentOutcome {
        probes: Vec::new(),
        diagnostics: Vec::new(),
        file_ids: HashMap::new(),
        cancelled: false,
        duration_ms: 0.0,
    };
    let mut file_id: u32 = 0;
    for file in &snapshot.files {
        let source_path = session.root.join("src").join(&file.path);
        let output_path = session.root.join("generated").join(&file.path);
        if let Some(parent) = output_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if !(config.instruments)(&file.path) {
            let _ = tokio::fs::copy(&source_path, &output_path).await;
            continue;
        }
        file_id += 1;
        outcome
            .file_ids
            .insert(file_id, format!("src/{}", file.path));
        let source_map_path = session
            .root
            .join("generated")
            .join(format!(".atomis-{file_id}.json"));
        let mut args = config.command_prefix_args.clone();
        args.extend((config.extra_args)(&file.path));
        args.extend([
            "--input".to_string(),
            source_path.to_string_lossy().into_owned(),
            "--output".to_string(),
            output_path.to_string_lossy().into_owned(),
            "--source-map".to_string(),
            source_map_path.to_string_lossy().into_owned(),
            "--uri".to_string(),
            file.uri.clone(),
            "--version".to_string(),
            snapshot.version.to_string(),
            "--file-id".to_string(),
            file_id.to_string(),
        ]);
        if !settings.auto_inspect {
            args.push("--no-auto-inspect".to_string());
        }
        for id in &settings.manual_probe_ids {
            args.push("--manual".to_string());
            args.push(id.clone());
        }
        let instrument = supervisor::run(
            &config.command,
            &args,
            RunOptions {
                cwd: session.root.clone(),
                limits: ProcessLimits::new(config.timeout_ms, 1024 * 1024, 512 * 1024),
                cancel: cancel.clone(),
                probe_fd: false,
                env: Vec::new(),
                callbacks: StreamCallbacks::default(),
            },
        )
        .await;
        outcome.duration_ms += instrument.duration_ms;
        if instrument.cancelled || cancel.is_cancelled() {
            outcome.cancelled = true;
            return outcome;
        }
        if instrument.exit_code != Some(0) {
            let _ = events.send(RunnerEvent::Output {
                stream: Stream::Stderr,
                chunk: instrument.stderr.clone(),
                category: OutputCategory::Error,
                source_location: None,
            });
            outcome.diagnostics.push(instrument_error(
                config.source_name,
                &file.path,
                "Instrumentation failed",
            ));
            continue;
        }
        let metadata: InstrumentationOutput = match serde_json::from_str(&instrument.stdout) {
            Ok(metadata) => metadata,
            Err(error) => {
                outcome.diagnostics.push(instrument_error(
                    config.source_name,
                    &file.path,
                    &format!("Invalid instrumenter response: {error}"),
                ));
                continue;
            }
        };
        if metadata.protocol_version != 1 || metadata.document_version != snapshot.version {
            outcome.diagnostics.push(instrument_error(
                config.source_name,
                &file.path,
                "Instrumenter protocol/version mismatch",
            ));
            continue;
        }
        outcome
            .probes
            .extend(metadata.probes.into_iter().map(|mut probe| {
                probe.path = Some(format!("src/{}", file.path));
                probe
            }));
        if metadata.generated_path.is_none() {
            outcome
                .diagnostics
                .extend(metadata.parse_diagnostics.into_iter().map(|item| AppDiagnostic {
                    message: item.message,
                    path: Some(format!("src/{}", file.path)),
                    severity: Severity::Error,
                    line: item.line.unwrap_or(1),
                    column: item.column.unwrap_or(1),
                    end_line: None,
                    end_column: None,
                    code: None,
                    source: Some(config.source_name.to_string()),
                }));
        }
    }
    outcome
}

pub struct ExecuteConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: std::path::PathBuf,
    pub env: Vec<(String, String)>,
    pub timeout_ms: u64,
    /// Whether stdout runs through the marker parser (non-zig languages log
    /// through stdout too); zig streams stdout as plain program output.
    pub parse_stdout_markers: bool,
}

pub struct ExecuteOutcome {
    pub result: ProcessResult,
    pub probe_error: Option<String>,
}

/// Runs the instrumented program with the probe pipe on fd 3, the stderr
/// (and optionally stdout) marker parsers, and per-probe counting.
pub async fn execute_program(
    probes: &[ProbeDescriptor],
    file_ids: &HashMap<u32, String>,
    cancel: &CancellationToken,
    events: &Events,
    config: ExecuteConfig,
) -> ExecuteOutcome {
    let mut forwarder = ProbeForwarder::new(probes, events.clone());
    let stdout_events = events.clone();
    let mut stdout_parser = MarkerParser::new(
        Stream::Stdout,
        false,
        file_ids.clone(),
        Box::new(move |stream, chunk, category, location| {
            let _ = stdout_events.send(RunnerEvent::Output {
                stream,
                chunk: chunk.to_string(),
                category,
                source_location: location,
            });
        }),
    );
    let stderr_events = events.clone();
    let mut stderr_parser = MarkerParser::new(
        Stream::Stderr,
        true,
        file_ids.clone(),
        Box::new(move |stream, chunk, category, location| {
            let _ = stderr_events.send(RunnerEvent::Output {
                stream,
                chunk: chunk.to_string(),
                category,
                source_location: location,
            });
        }),
    );
    let plain_events = events.clone();
    let (result, probe_error) = {
        let forwarder = &mut forwarder;
        let mut probe_reader = ProbeReader::new(Box::new(move |event| forwarder.forward(event)));
        let stdout_ref = &mut stdout_parser;
        let stderr_ref = &mut stderr_parser;
        let reader_ref = &mut probe_reader;
        let parse_stdout = config.parse_stdout_markers;
        let result = supervisor::run(
            &config.command,
            &config.args,
            RunOptions {
                cwd: config.cwd,
                limits: ProcessLimits::new(config.timeout_ms, 512 * 1024, 512 * 1024),
                cancel: cancel.clone(),
                probe_fd: true,
                env: config.env,
                callbacks: StreamCallbacks {
                    stdout: Some(Box::new(move |chunk: &str| {
                        if parse_stdout {
                            stdout_ref.push(chunk);
                        } else {
                            let _ = plain_events.send(RunnerEvent::Output {
                                stream: Stream::Stdout,
                                chunk: chunk.to_string(),
                                category: OutputCategory::Program,
                                source_location: None,
                            });
                        }
                    })),
                    stderr: Some(Box::new(move |chunk: &str| stderr_ref.push(chunk))),
                    probe: Some(Box::new(move |chunk: &[u8]| reader_ref.push(chunk))),
                },
            },
        )
        .await;
        probe_reader.end();
        (result, probe_reader.error.clone())
    };
    stdout_parser.flush();
    stderr_parser.flush();
    ExecuteOutcome {
        result,
        probe_error,
    }
}

/// The shared post-execution ladder: cancelled → timed_out → limit/probe
/// error. Returns Some(outcome) when the run terminates here.
pub fn classify_execution(
    metrics: &mut RunResult,
    execution: &ExecuteOutcome,
    cancel: &CancellationToken,
) -> Option<super::RunnerOutcome> {
    let result = &execution.result;
    metrics.execution_ms = result.duration_ms;
    metrics.exit_code = result.exit_code;
    metrics.signal = result.signal.clone();
    metrics.timed_out = result.timed_out;
    metrics.cancelled = result.cancelled;
    if result.cancelled || cancel.is_cancelled() {
        metrics.reason = Some("cancelled".to_string());
        return Some(super::RunnerOutcome {
            result: metrics.clone(),
            terminal_state: super::TerminalState::Cancelled,
        });
    }
    if result.timed_out {
        metrics.reason = Some("execution timeout".to_string());
        return Some(super::RunnerOutcome {
            result: metrics.clone(),
            terminal_state: super::TerminalState::TimedOut,
        });
    }
    if result.limit.is_some() || execution.probe_error.is_some() {
        metrics.reason = Some(
            execution
                .probe_error
                .clone()
                .unwrap_or_else(|| format!("{} limit exceeded", result.limit.unwrap_or("runtime"))),
        );
        return Some(super::RunnerOutcome {
            result: metrics.clone(),
            terminal_state: super::TerminalState::RuntimeError,
        });
    }
    None
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub fn dedupe_diagnostics(diagnostics: Vec<AppDiagnostic>) -> Vec<AppDiagnostic> {
    let mut seen = std::collections::HashSet::new();
    diagnostics
        .into_iter()
        .filter(|d| {
            let key = format!(
                "{}:{}:{}:{}",
                d.path.as_deref().unwrap_or(""),
                d.line,
                d.column,
                d.message
            );
            seen.insert(key)
        })
        .collect()
}
