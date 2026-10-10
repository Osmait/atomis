//! What every language's runner has in common: the event surface they
//! emit on, the outcome they return, and the generated-mirror maintenance
//! around a run. The runners themselves live one per language folder.

#![allow(dead_code)]


use std::collections::HashMap;
use std::path::Path;

use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use crate::languages::ndjson::RawProbeEvent;
use crate::protocol::{
    AppDiagnostic, Language, LogSourceLocation, OutputCategory, ProbeDescriptor, RunResult,
    RunState, Stream, TestCase, TestStatus,
};
use crate::domain::session::{Session, SessionSettings, Snapshot};

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
    "atomis_runtime.rs",
    "atomis_runtime.go",
    "__atomis_runtime.mjs",
    "sitecustomize.py",
    "atomis_runtime.h",
    "atomis_runtime.hpp",
];

/// Clears the generated mirror while preserving every language runtime that
/// is present, so alternating runs in the same multilingual workspace never
/// destroy each other's support files.
///
/// The runtimes are never removed, not even briefly: this used to read them,
/// delete the directory and write them back, and a superseded run still
/// finishing beside the new one could read after the other's delete — both
/// then rebuilt the directory without them, and every later run of the
/// session failed on a missing runtime until the page was reloaded.
pub async fn reset_generated(root: &Path) -> std::io::Result<()> {
    let generated = root.join("generated");
    tokio::fs::create_dir_all(&generated).await?;
    let mut entries = tokio::fs::read_dir(&generated).await?;
    while let Some(entry) = entries.next_entry().await? {
        if RUNTIME_FILES.iter().any(|name| entry.file_name() == *name) {
            continue;
        }
        let path = entry.path();
        // Already gone means a concurrent reset got there first.
        let _ = if entry.file_type().await?.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };
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

/// Runs one language, through the pack that describes it. There is no
/// dispatch here on purpose: the language decides, and adding one does not
/// mean remembering to extend a `match` in this file.
pub async fn run_language(
    language: Language,
    session: &Session,
    snapshot: &Snapshot,
    settings: &SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> Option<RunnerOutcome> {
    let pack = crate::languages::packs::pack(language);
    Some((pack.execute)(session, snapshot, settings, cancel, events).await)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Four resets at once, two hundred times: the delete-and-restore
    /// version lost the runtime within a few dozen rounds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_resets_never_lose_a_runtime() {
        let root = std::env::temp_dir().join(format!("atomis-reset-{}", crate::util::random_hex(8)));
        let generated = root.join("generated");
        tokio::fs::create_dir_all(generated.join("nested")).await.unwrap();
        tokio::fs::write(generated.join("__atomis_runtime.mjs"), "runtime").await.unwrap();
        tokio::fs::write(generated.join("main.ts"), "old").await.unwrap();
        tokio::fs::write(generated.join("nested/util.ts"), "old").await.unwrap();
        for _ in 0..200 {
            let resets: Vec<_> = (0..4)
                .map(|_| {
                    let root = root.clone();
                    tokio::spawn(async move { reset_generated(&root).await })
                })
                .collect();
            for reset in resets {
                reset.await.unwrap().unwrap();
            }
            assert_eq!(
                tokio::fs::read_to_string(generated.join("__atomis_runtime.mjs")).await.unwrap(),
                "runtime"
            );
        }
        assert!(!generated.join("main.ts").exists());
        assert!(!generated.join("nested").exists());
        let _ = tokio::fs::remove_dir_all(&root).await;
    }
}
