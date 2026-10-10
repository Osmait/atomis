//! Rust runner mirrored from RustCompilerRunner.ts: instrument, cargo build
//! (JSON diagnostics), execute, then run libtest with --test-threads=1 and
//! fold its stdout into per-test results.

use std::sync::OnceLock;
use std::time::Instant;

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

fn cargo_env(root: &std::path::Path) -> Vec<(String, String)> {
    cargo_env_in(root, "target")
}

/// Cargo locks its target directory for the whole build, so two builds
/// meant to overlap need one each.
fn cargo_env_in(root: &std::path::Path, target: &str) -> Vec<(String, String)> {
    vec![
        ("CARGO_NET_OFFLINE".into(), "true".into()),
        (
            "CARGO_TARGET_DIR".into(),
            root.join(target).to_string_lossy().into_owned(),
        ),
        ("CARGO_TERM_COLOR".into(), "never".into()),
    ]
}

/// The rustc invocation `cargo build --bin atomis-session` amounts to, for
/// a session cargo has nothing else to do for: no dependencies, no build
/// script. `None` sends the build through cargo.
///
/// Cargo was ~25 of ~75 ms of every warm build: resolving, fingerprinting
/// and then running this same rustc. One codegen unit, too: for a crate
/// this small, splitting it cost more than the parallelism returned.
fn direct_rustc_args(root: &std::path::Path, manifest: &str) -> Option<Vec<String>> {
    direct_args(root, manifest, DirectBuild::Program)
}

/// What `direct_args` builds: the instrumented program, or the visible
/// source's test harness (`cargo test --bin atomis-check --no-run`).
#[derive(Clone, Copy)]
enum DirectBuild {
    Program,
    Tests,
}

impl DirectBuild {
    /// Crate name, source, target directory and output, as cargo has them.
    fn layout(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            DirectBuild::Program => ("atomis_session", "generated/main.rs", "target", "debug/atomis-session"),
            DirectBuild::Tests => ("atomis_check", "src/main.rs", "target-tests", "debug/atomis-check-test"),
        }
    }
}

fn direct_args(root: &std::path::Path, manifest: &str, build: DirectBuild) -> Option<Vec<String>> {
    if root.join("build.rs").exists() || declares_dependencies(manifest) {
        return None;
    }
    let (crate_name, source, target_dir, output) = build.layout();
    let edition = manifest
        .lines()
        .find_map(|line| line.trim().strip_prefix("edition"))
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or("2021");
    let target = root.join(target_dir);
    let mut args: Vec<String> = vec![
        "--crate-name".into(),
        crate_name.into(),
        format!("--edition={edition}"),
        source.into(),
    ];
    if matches!(build, DirectBuild::Tests) {
        args.push("--test".into());
    } else {
        args.extend(["--crate-type".into(), "bin".into()]);
    }
    args.extend([
        "--error-format=json".into(),
        "--json=diagnostic-rendered-ansi".into(),
        "-C".into(),
        "embed-bitcode=no".into(),
        "-C".into(),
        "codegen-units=1".into(),
        "-C".into(),
        "strip=debuginfo".into(),
        "-C".into(),
        format!("incremental={}", target.join("direct-incremental").to_string_lossy()),
        "-o".into(),
        target.join(output).to_string_lossy().into_owned(),
    ]);
    Some(args)
}

/// Any dependency table with an entry in it.
fn declares_dependencies(manifest: &str) -> bool {
    let mut in_dependencies = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_dependencies = line.contains("dependencies");
            // `[dependencies.serde]`: a table that is itself a dependency.
            if in_dependencies && line.trim_matches(['[', ']']).contains("dependencies.") {
                return true;
            }
            continue;
        }
        if in_dependencies && !line.is_empty() && !line.starts_with('#') {
            return true;
        }
    }
    false
}

/// rustc's JSON diagnostics in the envelope cargo puts them in, so the
/// parser that reads cargo's output reads these unchanged.
fn as_cargo_messages(rustc_stderr: &str) -> String {
    rustc_stderr
        .lines()
        .filter(|line| line.trim_start().starts_with('{') && line.contains("\"$message_type\":\"diagnostic\""))
        .map(|line| format!("{{\"reason\":\"compiler-message\",\"message\":{line}}}\n"))
        .collect()
}

/// A background build that is killed with the run that started it: a run
/// that ends early (a compile error, a superseding edit) does not leave a
/// cargo building tests nobody will run.
struct TestBuild(tokio::task::JoinHandle<supervisor::ProcessResult>);

impl Drop for TestBuild {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Starts `cargo test --no-run` for the visible source right away. It only
/// reads `src/` — the uninstrumented `atomis-check` binary — so it can
/// build while the program is instrumented, compiled and run, instead of
/// after: that wait was ~70 ms of every warm Rust run with tests.
fn start_test_build(
    session: &Session,
    settings: &SessionSettings,
    cancel: &CancellationToken,
) -> TestBuild {
    let root = session.root.clone();
    let sandbox = session.sandbox(settings);
    let cancel = cancel.clone();
    TestBuild(tokio::spawn(async move {
        // rustc --test directly when cargo has nothing else to do, like the
        // program's build; its result dressed as cargo's for run_tests.
        let manifest = tokio::fs::read_to_string(root.join("Cargo.toml")).await.unwrap_or_default();
        if let Some(args) = direct_args(&root, &manifest, DirectBuild::Tests) {
            let _ = tokio::fs::create_dir_all(root.join("target-tests/debug")).await;
            let mut build = supervisor::run(
                "rustc",
                &args,
                RunOptions {
                    cwd: root.clone(),
                    limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 512 * 1024, 8 * 1024 * 1024),
                    cancel: cancel.clone(),
                    probe_fd: false,
                    env: cargo_env_in(&root, "target-tests"),
                    sandbox: sandbox.clone(),
                    callbacks: StreamCallbacks::default(),
                },
            )
            .await;
            if build.exit_code.is_some() || build.cancelled || build.timed_out {
                build.stdout = as_cargo_messages(&build.stderr);
                if build.exit_code == Some(0) {
                    let executable = root.join("target-tests").join(DirectBuild::Tests.layout().3);
                    build.stdout.push_str(&format!(
                        "{}\n",
                        serde_json::json!({
                            "reason": "compiler-artifact",
                            "profile": { "test": true },
                            "target": { "name": "atomis-check" },
                            "executable": executable.to_string_lossy(),
                        })
                    ));
                }
                return build;
            }
        }
        supervisor::run(
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
                cwd: root.clone(),
                limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 8 * 1024 * 1024, 512 * 1024),
                cancel,
                probe_fd: false,
                env: cargo_env_in(&root, "target-tests"),
                sandbox,
                callbacks: StreamCallbacks::default(),
            },
        )
        .await
    }))
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
    let mut test_build = (!test_catalog.is_empty()).then(|| start_test_build(session, settings, &cancel));
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
            worker: None,
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
    let manifest = tokio::fs::read_to_string(session.root.join("Cargo.toml"))
        .await
        .unwrap_or_default();
    let direct = match direct_rustc_args(&session.root, &manifest) {
        Some(args) => {
            let _ = tokio::fs::create_dir_all(session.root.join("target/debug")).await;
            let mut compile = supervisor::run(
                "rustc",
                &args,
                RunOptions {
                    cwd: session.root.clone(),
                    limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 512 * 1024, 8 * 1024 * 1024),
                    cancel: cancel.clone(),
                    probe_fd: false,
                    env: cargo_env(&session.root),
                    sandbox: session.sandbox(settings),
                    callbacks: StreamCallbacks::default(),
                },
            )
            .await;
            // A rustc that did not start at all is cargo's to try; one that
            // ran and failed has the diagnostics.
            if compile.exit_code.is_none() && !compile.cancelled && !compile.timed_out {
                None
            } else {
                compile.stdout = as_cargo_messages(&compile.stderr);
                Some(compile)
            }
        }
        None => None,
    };
    let compile = match direct {
        Some(compile) => compile,
        None => supervisor::run(
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
        .await,
    };
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
        metrics.timed_out = compile.timed_out;
        metrics.reason = Some(compile_failure_reason(&compile));
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
        run_tests(session, settings, &test_catalog, test_build.take(), &cancel, &events).await;
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
    run_tests(session, settings, &test_catalog, test_build.take(), &cancel, &events).await;
    RunnerOutcome {
        result: metrics,
        terminal_state: TerminalState::Succeeded,
    }
}

async fn run_tests(
    session: &Session,
    settings: &SessionSettings,
    catalog: &[TestCase],
    build: Option<TestBuild>,
    cancel: &CancellationToken,
    events: &Events,
) {
    let Some(mut build) = build else { return };
    if catalog.is_empty() || cancel.is_cancelled() {
        return;
    }
    let _ = events.send(RunnerEvent::State(RunState::Testing));
    let Ok(build) = (&mut build.0).await else {
        return;
    };
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
        // Real `test name ... ok` lines all precede the first failure-detail
        // block; a block REPLAYS captured stdout, and a test that printed
        // such a line itself (a spawned thread escapes libtest's capture)
        // must not mint phantom results.
        let mut in_failure_details = false;
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
                            let line = line.trim_end_matches('\n');
                            if line.starts_with("---- ") && line.ends_with(" ----") {
                                in_failure_details = true;
                            }
                            if in_failure_details {
                                continue;
                            }
                            if let Some(parsed) = parse_libtest_line(line) {
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

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = "[package]\nname = \"atomis_session\"\nedition = \"2021\"\n\n[[bin]]\nname = \"atomis-session\"\npath = \"generated/main.rs\"\n\n[profile.dev]\ndebug = 0\n";

    #[test]
    fn a_manifest_without_dependencies_builds_with_rustc_directly() {
        let root = std::path::Path::new("/nonexistent/session");
        let args = direct_rustc_args(root, TEMPLATE).expect("direct");
        assert!(args.contains(&"--edition=2021".to_string()));
        assert!(args.contains(&"codegen-units=1".to_string()));
        assert!(args.ends_with(&[
            "-o".to_string(),
            "/nonexistent/session/target/debug/atomis-session".to_string()
        ]));
        // An empty table is still no dependency.
        assert!(direct_rustc_args(root, &format!("{TEMPLATE}\n[dependencies]\n# none yet\n")).is_some());
        // Any dependency, in any table form, is cargo's.
        for deps in [
            "[dependencies]\nrand = \"0.8\"\n",
            "[dependencies.serde]\nversion = \"1\"\n",
            "[dev-dependencies]\nquickcheck = \"1\"\n",
        ] {
            assert!(direct_rustc_args(root, &format!("{TEMPLATE}{deps}")).is_none(), "{deps}");
        }
        let newer = direct_rustc_args(root, &TEMPLATE.replace("2021", "2024")).expect("direct");
        assert!(newer.contains(&"--edition=2024".to_string()));
    }

    #[test]
    fn rustc_diagnostics_read_like_cargos() {
        let rustc = r#"{"$message_type":"diagnostic","message":"mismatched types","code":null,"level":"error","spans":[{"file_name":"generated/main.rs","line_start":3,"line_end":3,"column_start":18,"column_end":22,"is_primary":true}],"children":[],"rendered":"error"}
not json
{"$message_type":"artifact","artifact":"x"}"#;
        let diagnostics = parse_cargo_diagnostics(&as_cargo_messages(rustc));
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].message, "mismatched types");
        assert_eq!(diagnostics[0].line, 3);
    }
}
