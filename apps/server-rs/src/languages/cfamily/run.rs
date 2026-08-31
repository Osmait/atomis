//! C/C++ runner mirrored from CFamilyCompilerRunner.ts + CFamilyDiscovery.ts:
//! instrument via the clang-AST node script, compile with -include runtime,
//! execute, then build and run the generated test main.

use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use regex::Regex;
use tokio_util::sync::CancellationToken;

use crate::languages::ndjson::{RawTestEvent, RawTestStatus, TestReader};
use crate::languages::packs;
use crate::protocol::{
    AppDiagnostic, Language, OutputCategory, ProjectFile, RunResult, RunState, Severity, Stream,
    TestCase, TestStatus,
};
use crate::domain::session::{Session, SessionSettings, Snapshot};
use crate::exec::supervisor::{self, ProcessLimits, RunOptions, StreamCallbacks};

use crate::languages::common::report_aborted_tests;
use crate::languages::common::{
    classify_execution, compile_failure_reason, dedupe_diagnostics, execute_program, instrument_files,
    ExecuteConfig, InstrumentConfig,
};
use crate::languages::runtime::{cancelled_outcome, reset_generated, Events, RunnerEvent, RunnerOutcome, TerminalState};

const COMPILE_TIMEOUT_MS: u64 = 60_000;

#[derive(Clone, Copy)]
pub struct CFamilyConfig {
    pub language: Language,
    pub compiler: &'static str,
    pub std: &'static str,
    pub runtime_header: &'static str,
    /// What `-x` calls this header when precompiling it.
    pub header_language: &'static str,
    pub test_main_name: &'static str,
}

pub const C_CONFIG: CFamilyConfig = CFamilyConfig {
    language: Language::C,
    compiler: "clang",
    std: "c17",
    runtime_header: "atomis_runtime.h",
    header_language: "c-header",
    test_main_name: "__atomis_test_main.c",
};

pub const CPP_CONFIG: CFamilyConfig = CFamilyConfig {
    language: Language::Cpp,
    compiler: "clang++",
    std: "c++20",
    runtime_header: "atomis_runtime.hpp",
    header_language: "c++-header",
    test_main_name: "__atomis_test_main.cpp",
};

impl CFamilyConfig {
    fn is_code(&self, path: &str) -> bool {
        match self.language {
            Language::C => path.ends_with(".c"),
            _ => path.ends_with(".cpp") || path.ends_with(".cc"),
        }
    }

    fn is_test(&self, path: &str) -> bool {
        match self.language {
            Language::C => path.ends_with("_test.c"),
            _ => path.ends_with("_test.cpp") || path.ends_with("_test.cc"),
        }
    }
}

pub fn discover_cfamily_tests(files: &[ProjectFile], config: &CFamilyConfig) -> Vec<TestCase> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"^\s*void\s+(test_\w+)\s*\(\s*(?:void)?\s*\)").expect("static"));
    let mut tests = Vec::new();
    for file in files {
        if !config.is_test(&file.path) {
            continue;
        }
        for (index, line) in file.source.split('\n').enumerate() {
            let Some(capture) = re.captures(line) else {
                continue;
            };
            tests.push(TestCase {
                test_id: format!("{}:{}", file.path, index + 1),
                path: format!("src/{}", file.path),
                name: capture.get(1).map(|m| m.as_str()).unwrap_or("").to_string(),
                line: (index + 1) as u32,
                column: 1,
            });
        }
    }
    tests
}

/// Clang spends most of a small program's compile on the runtime header's
/// standard includes — measured at ~200ms of ~320ms for the C++ scaffold.
/// Precompiling that header once per session turns every later compile into
/// ~127ms. Returns None when the PCH cannot be built, and the caller falls
/// back to including the header the ordinary way: a slower run beats a
/// broken one.
async fn runtime_pch(
    session: &Session,
    settings: &SessionSettings,
    config: &CFamilyConfig,
    cancel: &CancellationToken,
) -> (Option<std::path::PathBuf>, f64) {
    // The repository's copy, not the session's: `generated/` is rewritten on
    // every run, so its mtime always looks newer than the PCH and the header
    // would be recompiled every time — which measured slower than not
    // precompiling at all. The two files have identical content; the session
    // copy is scaffolded from this one.
    let header = crate::languages::packs::project_root()
        .join("cfamily/runtime")
        .join(config.runtime_header);
    let target = session.root.join("target");
    if tokio::fs::create_dir_all(&target).await.is_err() {
        return (None, 0.0);
    }
    let pch = target.join(format!("{}-runtime.pch", config.runtime_header));
    // Reuse it while it is at least as new as the header it was built from
    // AND the compiler is still the binary that built it. A persistent
    // workspace outlives clang upgrades, and clang refuses a foreign PCH
    // with an error the diagnostics regex cannot map to any source line.
    let stamp_path = target.join(format!("{}-runtime.pch.toolchain", config.runtime_header));
    let stamp = compiler_stamp(config.compiler);
    let fresh = match (tokio::fs::metadata(&pch).await, tokio::fs::metadata(&header).await) {
        (Ok(built), Ok(source)) => match (built.modified(), source.modified()) {
            (Ok(built), Ok(source)) => built >= source,
            _ => false,
        },
        _ => false,
    } && tokio::fs::read_to_string(&stamp_path)
        .await
        .is_ok_and(|stored| stored == stamp);
    if fresh {
        return (Some(pch), 0.0);
    }
    let result = supervisor::run(
        config.compiler,
        &[
            format!("-std={}", config.std),
            "-g".into(),
            "-O0".into(),
            "-x".into(),
            config.header_language.into(),
            header.to_string_lossy().into_owned(),
            "-o".into(),
            pch.to_string_lossy().into_owned(),
        ],
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 256 * 1024, 1024 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: Vec::new(),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    if result.exit_code == Some(0) {
        let _ = tokio::fs::write(&stamp_path, &stamp).await;
        (Some(pch), result.duration_ms)
    } else {
        (None, result.duration_ms)
    }
}

/// Identity of the compiler binary itself (size + mtime of what PATH
/// resolves), so an upgraded clang invalidates PCHs without a per-run
/// `--version` probe eating the time the PCH exists to save.
fn compiler_stamp(compiler: &str) -> String {
    let resolved = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(compiler))
            .find(|candidate| candidate.is_file())
    });
    match resolved.and_then(|p| std::fs::metadata(p).ok()) {
        Some(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}:{}", meta.len(), modified)
        }
        None => "unknown".to_string(),
    }
}

fn clang_project_path(file: &str) -> Option<String> {
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

pub fn parse_clang_diagnostics(stderr: &str) -> Vec<AppDiagnostic> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(.+?\.(?:c|h|cpp|cc|hpp)):(\d+):(\d+): (error|warning|fatal error): (.+)$")
            .expect("static")
    });
    let mut diagnostics = Vec::new();
    for line in stderr.split('\n') {
        let Some(capture) = re.captures(line.trim()) else {
            continue;
        };
        let file = capture.get(1).map(|m| m.as_str()).unwrap_or("");
        let severity_text = capture.get(4).map(|m| m.as_str()).unwrap_or("error");
        diagnostics.push(AppDiagnostic {
            message: capture.get(5).map(|m| m.as_str()).unwrap_or("").to_string(),
            path: clang_project_path(file),
            severity: if severity_text == "warning" {
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
            source: Some("clang".to_string()),
        });
    }
    dedupe_diagnostics(diagnostics)
}

/// Generates the test main translation unit (byte parity with
/// buildCFamilyTestMain in CFamilyDiscovery.ts).
pub fn build_test_main(tests: &[TestCase], config: &CFamilyConfig) -> String {
    let declarations: String = tests
        .iter()
        .map(|test| {
            if config.language == Language::C {
                format!("void {}(void);", test.name)
            } else {
                format!("void {}();", test.name)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let entries: String = tests
        .iter()
        .map(|test| format!("\t{{\"{}\", {}}},", test.name, test.name))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"#define _POSIX_C_SOURCE 199309L
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

{declarations}

struct __atomis_test {{
	const char *name;
	void (*fn)(void);
}};

static struct __atomis_test __atomis_tests[] = {{
{entries}
}};

static void __atomis_write(const char *record) {{
	ssize_t written = write(3, record, strlen(record));
	(void)written;
}}

static long long __atomis_now(void) {{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}}

int main(void) {{
	char record[512];
	int total = (int)(sizeof __atomis_tests / sizeof __atomis_tests[0]);
	int passed = 0;
	for (int index = 0; index < total; index++) {{
		snprintf(record, sizeof record,
			"{{\"protocolVersion\":1,\"kind\":\"test_start\",\"index\":%d,\"name\":\"%.300s\"}}\n",
			index, __atomis_tests[index].name);
		__atomis_write(record);
		long long started = __atomis_now();
		__atomis_tests[index].fn();
		long long elapsed = __atomis_now() - started;
		snprintf(record, sizeof record,
			"{{\"protocolVersion\":1,\"kind\":\"test_result\",\"index\":%d,\"status\":\"passed\",\"durationNs\":%lld,\"name\":\"%.300s\"}}\n",
			index, elapsed, __atomis_tests[index].name);
		__atomis_write(record);
		passed++;
	}}
	snprintf(record, sizeof record,
		"{{\"protocolVersion\":1,\"kind\":\"test_summary\",\"passed\":%d,\"failed\":0,\"skipped\":0,\"leaked\":0}}\n",
		passed);
	__atomis_write(record);
	return 0;
}}
"#
    )
}

pub async fn run(
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    cancel: CancellationToken,
    events: Events,
    config: CFamilyConfig,
) -> RunnerOutcome {
    let mut metrics = RunResult::default();
    let emit = |event: RunnerEvent| {
        let _ = events.send(event);
    };

    emit(RunnerEvent::State(RunState::Instrumenting));
    let test_catalog = discover_cfamily_tests(&snapshot.files, &config);
    emit(RunnerEvent::TestCatalog(test_catalog.clone()));
    let _ = reset_generated(&session.root).await;
    let instrumenter = packs::instrumenter_path(config.language);
    let lang_flag = if config.language == Language::C {
        "c"
    } else {
        "cpp"
    };
    let outcome = instrument_files(
        session,
        snapshot,
        settings,
        &cancel,
        &events,
        InstrumentConfig {
            source_name: "clive-instrument",
            instruments: &|path| config.is_code(path) && !config.is_test(path),
            command: "node".to_string(),
            command_prefix_args: vec![
                instrumenter.to_string_lossy().into_owned(),
                "--lang".to_string(),
                lang_flag.to_string(),
            ],
            extra_args: &|_| Vec::new(),
            timeout_ms: 15_000,
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
    let code_files: Vec<&ProjectFile> = snapshot
        .files
        .iter()
        .filter(|f| config.is_code(&f.path) && !config.is_test(&f.path))
        .collect();
    let executable = session
        .root
        .join("target")
        .join(format!("{lang_flag}-bin"));
    let _ = tokio::fs::create_dir_all(session.root.join("target")).await;
    let (pch, pch_ms) = runtime_pch(session, settings, &config, &cancel).await;
    let mut compile_args: Vec<String> = vec![
        format!("-std={}", config.std),
        "-g".into(),
        "-O0".into(),
    ];
    match &pch {
        Some(pch) => {
            compile_args.push("-include-pch".into());
            compile_args.push(pch.to_string_lossy().into_owned());
        }
        None => {
            compile_args.push("-include".into());
            compile_args.push(
                session
                    .root
                    .join("generated")
                    .join(config.runtime_header)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    for file in &code_files {
        compile_args.push(
            session
                .root
                .join("generated")
                .join(&file.path)
                .to_string_lossy()
                .into_owned(),
        );
    }
    compile_args.push("-o".into());
    compile_args.push(executable.to_string_lossy().into_owned());
    compile_args.push("-lm".into());
    let compile = supervisor::run(
        config.compiler,
        &compile_args,
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 512 * 1024, 1024 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: Vec::new(),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    // Building the header counts as compiling: it is time the person waits.
    metrics.compilation_ms = compile.duration_ms + pch_ms;
    if compile.cancelled || cancel.is_cancelled() {
        return cancelled_outcome(metrics, "superseded");
    }
    let compile_diagnostics = parse_clang_diagnostics(&compile.stderr);
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
            Regex::new(r"(?:generated|src)[/\\]([\w./-]+\.(?:c|cpp|cc|h|hpp)):(\d+)")
                .expect("static")
        });
        let location = re.captures(&result.stderr);
        emit(RunnerEvent::Diagnostic {
            owner: "runtime".to_string(),
            diagnostics: vec![AppDiagnostic {
                message: "Program crashed or exited abnormally".to_string(),
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
        run_tests(session, snapshot, settings, &test_catalog, &cancel, &events, &config).await;
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
    run_tests(session, snapshot, settings, &test_catalog, &cancel, &events, &config).await;
    RunnerOutcome {
        result: metrics,
        terminal_state: TerminalState::Succeeded,
    }
}

async fn run_tests(
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    catalog: &[TestCase],
    cancel: &CancellationToken,
    events: &Events,
    config: &CFamilyConfig,
) {
    if catalog.is_empty() || cancel.is_cancelled() {
        return;
    }
    let _ = events.send(RunnerEvent::State(RunState::Testing));
    let lang_flag = if config.language == Language::C {
        "c"
    } else {
        "cpp"
    };
    let test_main_path = session.root.join("generated").join(config.test_main_name);
    let _ = tokio::fs::write(&test_main_path, build_test_main(catalog, config)).await;
    // The run's snapshot, not `session.current()`: an edit landing during
    // the Running phase must not swap the file list under a catalog whose
    // ids were already announced for the old one.
    let user_sources: Vec<&ProjectFile> = snapshot
        .files
        .iter()
        .filter(|f| config.is_code(&f.path) && !config.is_test(&f.path))
        .collect();
    let test_sources: Vec<&ProjectFile> = snapshot
        .files
        .iter()
        .filter(|f| config.is_test(&f.path))
        .collect();
    let object_dir = session.root.join("target").join(format!("{lang_flag}-obj"));
    let _ = tokio::fs::create_dir_all(&object_dir).await;
    let mut objects: Vec<String> = Vec::new();
    let empty_summary = |duration: f64| RunnerEvent::TestSummary {
        passed: 0,
        failed: 0,
        skipped: 0,
        leaked: 0,
        duration_ms: duration,
    };
    for (index, file) in user_sources.iter().enumerate() {
        let object = object_dir.join(format!("{index}.o"));
        let compile = supervisor::run(
            config.compiler,
            &[
                format!("-std={}", config.std),
                "-g".into(),
                "-O0".into(),
                "-Dmain=__atomis_user_main".into(),
                "-c".into(),
                session
                    .root
                    .join("src")
                    .join(&file.path)
                    .to_string_lossy()
                    .into_owned(),
                "-o".into(),
                object.to_string_lossy().into_owned(),
            ],
            RunOptions {
                cwd: session.root.clone(),
                limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 256 * 1024, 1024 * 1024),
                cancel: cancel.clone(),
                probe_fd: false,
                env: Vec::new(),
                sandbox: session.sandbox(settings),
                callbacks: StreamCallbacks::default(),
            },
        )
        .await;
        if compile.cancelled || cancel.is_cancelled() {
            return;
        }
        if compile.exit_code != Some(0) {
            let diagnostics = parse_clang_diagnostics(&compile.stderr);
            if diagnostics.is_empty() {
                let _ = events.send(RunnerEvent::Output {
                    stream: Stream::Stderr,
                    chunk: compile.stderr.clone(),
                    category: OutputCategory::Error,
                    source_location: None,
                });
            } else {
                let _ = events.send(RunnerEvent::Diagnostic {
                    owner: "compiler".to_string(),
                    diagnostics,
                });
            }
            let _ = events.send(empty_summary(compile.duration_ms));
            return;
        }
        objects.push(object.to_string_lossy().into_owned());
    }
    let test_executable = session
        .root
        .join("target")
        .join(format!("{lang_flag}-test-bin"));
    let mut link_args: Vec<String> = vec![
        format!("-std={}", config.std),
        "-g".into(),
        "-O0".into(),
    ];
    link_args.extend(objects);
    for file in &test_sources {
        link_args.push(
            session
                .root
                .join("src")
                .join(&file.path)
                .to_string_lossy()
                .into_owned(),
        );
    }
    link_args.push(test_main_path.to_string_lossy().into_owned());
    link_args.push("-o".into());
    link_args.push(test_executable.to_string_lossy().into_owned());
    link_args.push("-lm".into());
    let link = supervisor::run(
        config.compiler,
        &link_args,
        RunOptions {
            cwd: session.root.clone(),
            limits: ProcessLimits::new(COMPILE_TIMEOUT_MS, 256 * 1024, 1024 * 1024),
            cancel: cancel.clone(),
            probe_fd: false,
            env: Vec::new(),
            sandbox: session.sandbox(settings),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await;
    if link.cancelled || cancel.is_cancelled() {
        return;
    }
    if link.exit_code != Some(0) {
        let diagnostics = parse_clang_diagnostics(&link.stderr);
        if diagnostics.is_empty() {
            let _ = events.send(RunnerEvent::Output {
                stream: Stream::Stderr,
                chunk: link.stderr.clone(),
                category: OutputCategory::Error,
                source_location: None,
            });
        } else {
            let _ = events.send(RunnerEvent::Diagnostic {
                owner: "compiler".to_string(),
                diagnostics,
            });
        }
        let _ = events.send(empty_summary(link.duration_ms));
        return;
    }

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
        let mut state = reader_state.lock().expect("cfamily test state");
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
                ..
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
                let matched = catalog_owned.iter().find(|c| c.name == name);
                let _ = reader_events.send(RunnerEvent::TestResult {
                    test_id: matched.map(|m| m.test_id.clone()),
                    name: matched.map(|m| m.name.clone()).unwrap_or(name),
                    status,
                    duration_ms: duration_ns / 1_000_000.0,
                    message: None,
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

    let stderr_state = Arc::clone(&state);
    let execution = {
        let reader_ref = &mut reader;
        supervisor::run(
            &test_executable.to_string_lossy(),
            &[],
            RunOptions {
                cwd: session.root.join("src"),
                limits: ProcessLimits::new(settings.timeout_ms.max(3000), 512 * 1024, 512 * 1024),
                cancel: cancel.clone(),
                probe_fd: true,
                env: Vec::new(),
                sandbox: session.sandbox(settings),
                callbacks: StreamCallbacks {
                    stdout: None,
                    stderr: Some(Box::new(move |chunk: &str| {
                        stderr_state
                            .lock()
                            .expect("cfamily stderr")
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
    let mut state = state.lock().expect("cfamily test state");
    let started: Vec<String> = state.started.values().cloned().collect();
    let state = &mut *state;
    state.counts.1 += report_aborted_tests(
        started,
        &mut state.stderr_buffer,
        &execution.stderr,
        execution.timed_out,
        events,
        &|name| catalog.iter().find(|c| c.name == name).map(|c| (c.test_id.clone(), c.name.clone())),
    );
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
