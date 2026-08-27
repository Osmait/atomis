//! Language runners: the shared event surface (RunnerEvent), outcomes and
//! generated-mirror maintenance, mirroring CompilerRunner.ts exports.

#![allow(dead_code)]

pub mod cfamily;
pub mod common;
pub mod go;
pub mod py;
pub mod rust;
pub mod ts;
pub mod zig;
pub mod zig_diag;

use std::collections::HashMap;
use std::path::Path;

use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use crate::ndjson::RawProbeEvent;
use crate::protocol::{
    AppDiagnostic, Language, LogSourceLocation, OutputCategory, ProbeDescriptor, RunResult,
    RunState, Stream, TestCase, TestStatus,
};
use crate::session::{Session, SessionSettings, Snapshot};

#[derive(Debug)]
pub enum RunnerEvent {
    State(RunState),
    Catalog(Vec<ProbeDescriptor>),
    TestCatalog(Vec<TestCase>),
    TestResult {
        test_id: Option<String>,
        name: String,
        status: TestStatus,
        duration_ms: f64,
        message: Option<String>,
    },
    TestSummary {
        passed: u32,
        failed: u32,
        skipped: u32,
        leaked: u32,
        duration_ms: f64,
    },
    Output {
        stream: Stream,
        chunk: String,
        category: OutputCategory,
        source_location: Option<LogSourceLocation>,
    },
    Diagnostic {
        owner: String,
        diagnostics: Vec<AppDiagnostic>,
    },
    Probe {
        raw: RawProbeEvent,
        path: Option<String>,
        count: u32,
    },
}

pub type Events = UnboundedSender<RunnerEvent>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalState {
    Succeeded,
    CompileError,
    RuntimeError,
    TimedOut,
    Cancelled,
}

impl TerminalState {
    pub fn as_run_state(self) -> RunState {
        match self {
            TerminalState::Succeeded => RunState::Succeeded,
            TerminalState::CompileError => RunState::CompileError,
            TerminalState::RuntimeError => RunState::RuntimeError,
            TerminalState::TimedOut => RunState::TimedOut,
            TerminalState::Cancelled => RunState::Cancelled,
        }
    }
}

pub struct RunnerOutcome {
    pub result: RunResult,
    pub terminal_state: TerminalState,
}

pub const RUNTIME_FILES: [&str; 7] = [
    "runzig_runtime.zig",
    "ziglive_runtime.rs",
    "ziglive_runtime.go",
    "__ziglive_runtime.mjs",
    "sitecustomize.py",
    "ziglive_runtime.h",
    "ziglive_runtime.hpp",
];

/// Clears the generated mirror while preserving every language runtime that
/// is present, so alternating runs in the same multilingual workspace never
/// destroy each other's support files.
pub async fn reset_generated(root: &Path) -> std::io::Result<()> {
    let generated = root.join("generated");
    let mut preserved: Vec<(&str, Vec<u8>)> = Vec::new();
    for name in RUNTIME_FILES {
        if let Ok(content) = tokio::fs::read(generated.join(name)).await {
            preserved.push((name, content));
        }
    }
    let _ = tokio::fs::remove_dir_all(&generated).await;
    tokio::fs::create_dir_all(&generated).await?;
    for (name, content) in preserved {
        tokio::fs::write(generated.join(name), content).await?;
    }
    Ok(())
}

/// Shared instrumenter JSON response (identical across every language CLI).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentationOutput {
    pub protocol_version: u8,
    pub document_version: u64,
    #[serde(default)]
    pub generated_path: Option<String>,
    #[serde(default)]
    pub source_map_path: Option<String>,
    pub probes: Vec<ProbeDescriptor>,
    #[serde(default)]
    pub parse_diagnostics: Vec<ParseDiagnostic>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ParseDiagnostic {
    pub message: String,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
}

pub fn cancelled_outcome(mut metrics: RunResult, reason: &str) -> RunnerOutcome {
    metrics.cancelled = true;
    metrics.reason = Some(reason.to_string());
    RunnerOutcome {
        result: metrics,
        terminal_state: TerminalState::Cancelled,
    }
}

/// Dispatch a run for one language.
pub async fn run_language(
    language: Language,
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> Option<RunnerOutcome> {
    match language {
        Language::Zig => Some(zig::run(session, snapshot, settings, cancel, events).await),
        Language::Rust => Some(rust::run(session, snapshot, settings, cancel, events).await),
        Language::Go => Some(go::run(session, snapshot, settings, cancel, events).await),
        Language::Ts => Some(ts::run(session, snapshot, settings, cancel, events).await),
        Language::Py => Some(py::run(session, snapshot, settings, cancel, events).await),
        Language::C => Some(
            cfamily::run(session, snapshot, settings, cancel, events, cfamily::C_CONFIG).await,
        ),
        Language::Cpp => Some(
            cfamily::run(
                session,
                snapshot,
                settings,
                cancel,
                events,
                cfamily::CPP_CONFIG,
            )
            .await,
        ),
    }
}

/// Streaming probe forwarder shared by every runner: counts per probe id and
/// resolves the file path from the catalog.
pub struct ProbeForwarder {
    counts: HashMap<String, u32>,
    paths: HashMap<String, Option<String>>,
    events: Events,
}

impl ProbeForwarder {
    pub fn new(probes: &[ProbeDescriptor], events: Events) -> Self {
        ProbeForwarder {
            counts: HashMap::new(),
            paths: probes
                .iter()
                .map(|p| (p.probe_id.clone(), p.path.clone()))
                .collect(),
            events,
        }
    }

    pub fn forward(&mut self, raw: RawProbeEvent) {
        let count = self.counts.get(&raw.probe_id).copied().unwrap_or(0) + 1;
        self.counts.insert(raw.probe_id.clone(), count);
        let path = self.paths.get(&raw.probe_id).cloned().flatten();
        let _ = self.events.send(RunnerEvent::Probe { raw, path, count });
    }
}
