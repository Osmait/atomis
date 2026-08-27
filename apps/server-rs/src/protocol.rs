//! Wire types mirrored from packages/protocol (TypeScript). Additive and
//! field-for-field identical JSON: the frontend must not distinguish the
//! Rust backend from the Node one.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
pub const MAX_PROJECT_FILES: usize = 64;
pub const MAX_PROJECT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RUNTIME_MESSAGE_BYTES: usize = MAX_SOURCE_BYTES + 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Zig,
    Rust,
    Go,
    Ts,
    Py,
    C,
    Cpp,
}

pub const LANGUAGES: [Language; 7] = [
    Language::Zig,
    Language::Rust,
    Language::Go,
    Language::Ts,
    Language::Py,
    Language::C,
    Language::Cpp,
];

impl Language {
    pub fn as_str(self) -> &'static str {
        match self {
            Language::Zig => "zig",
            Language::Rust => "rust",
            Language::Go => "go",
            Language::Ts => "ts",
            Language::Py => "py",
            Language::C => "c",
            Language::Cpp => "cpp",
        }
    }

    pub fn parse(value: &str) -> Option<Language> {
        LANGUAGES.iter().copied().find(|l| l.as_str() == value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Idle,
    Debouncing,
    Instrumenting,
    Compiling,
    Running,
    Testing,
    Succeeded,
    CompileError,
    RuntimeError,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDescriptor {
    pub probe_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub name: String,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub original_range: SourceRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertion_byte: Option<u64>,
    pub mode: ProbeMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    pub test_id: String,
    pub path: String,
    pub name: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestStatus {
    Passed,
    Failed,
    Skipped,
    Leaked,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiagnostic {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub severity: Severity,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    pub path: String,
    pub uri: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainVersions {
    pub run: String,
    pub lsp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub auth_token: String,
    pub language: Language,
    pub document_uri: String,
    pub zig_version: String,
    pub zls_version: String,
    pub rustc_version: String,
    pub cargo_version: String,
    pub rust_analyzer_version: String,
    pub toolchains: serde_json::Map<String, serde_json::Value>,
    pub initial_source: String,
    pub files: Vec<ProjectFile>,
    pub degraded: serde_json::Map<String, serde_json::Value>,
    /// What this kernel can enforce: "files+network", "files" or
    /// "unsupported".
    pub sandbox_support: String,
    /// Whether new sessions start sandboxed (true wherever it is available).
    pub sandbox: bool,
    /// The persistent workspace this session is attached to, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<crate::workspace::WorkspaceMeta>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceScaffold {
    /// Every supported language's example files (the original workspace).
    #[default]
    Demo,
    /// Only the chosen language's entry file.
    Minimal,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CreateSessionRequest {
    pub language: Option<Language>,
    pub scaffold: Option<WorkspaceScaffold>,
    /// Attach to a persistent workspace instead of a throwaway session.
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFieldLayout {
    pub name: String,
    pub type_name: String,
    pub offset: u32,
    pub size: u32,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopInfo {
    pub line: u32,
    pub column: u32,
    pub variable: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSourceLocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub line: u32,
    pub column: u32,
    pub execution_index: u32,
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_info: Option<LoopInfo>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub instrumentation_ms: f64,
    pub compilation_ms: f64,
    pub execution_ms: f64,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ── Client → server messages (zod parity: strict, validated) ──

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum RuntimeClientMessage {
    #[serde(rename = "document.update")]
    DocumentUpdate {
        #[serde(rename = "sessionId")]
        session_id: String,
        version: u64,
        #[serde(default = "default_entry_path")]
        path: String,
        source: String,
    },
    #[serde(rename = "file.create")]
    FileCreate {
        #[serde(rename = "sessionId")]
        session_id: String,
        version: u64,
        path: String,
        source: String,
    },
    #[serde(rename = "file.rename")]
    FileRename {
        #[serde(rename = "sessionId")]
        session_id: String,
        version: u64,
        path: String,
        #[serde(rename = "newPath")]
        new_path: String,
    },
    #[serde(rename = "file.delete")]
    FileDelete {
        #[serde(rename = "sessionId")]
        session_id: String,
        version: u64,
        path: String,
    },
    #[serde(rename = "run.request")]
    RunRequest {
        #[serde(rename = "sessionId")]
        session_id: String,
        version: u64,
        reason: RunReason,
        language: Option<Language>,
    },
    #[serde(rename = "run.cancel")]
    RunCancel {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "settings.update")]
    SettingsUpdate {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "autoRun")]
        auto_run: bool,
        #[serde(rename = "autoInspect")]
        auto_inspect: bool,
        #[serde(rename = "debounceMs")]
        debounce_ms: u64,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
        #[serde(rename = "manualProbeIds")]
        manual_probe_ids: Vec<String>,
        #[serde(default)]
        sandbox: Option<bool>,
    },
}

fn default_entry_path() -> String {
    "main.zig".to_string()
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunReason {
    Manual,
    Auto,
}

impl RuntimeClientMessage {
    pub fn session_id(&self) -> &str {
        match self {
            RuntimeClientMessage::DocumentUpdate { session_id, .. }
            | RuntimeClientMessage::FileCreate { session_id, .. }
            | RuntimeClientMessage::FileRename { session_id, .. }
            | RuntimeClientMessage::FileDelete { session_id, .. }
            | RuntimeClientMessage::RunRequest { session_id, .. }
            | RuntimeClientMessage::RunCancel { session_id }
            | RuntimeClientMessage::SettingsUpdate { session_id, .. } => session_id,
        }
    }

    /// zod-parity validation beyond serde's shape checks.
    pub fn validate(&self) -> Result<(), String> {
        let check_version = |version: u64| -> Result<(), String> {
            if version == 0 {
                Err("version must be positive".into())
            } else {
                Ok(())
            }
        };
        match self {
            RuntimeClientMessage::DocumentUpdate {
                version,
                path,
                source,
                ..
            }
            | RuntimeClientMessage::FileCreate {
                version,
                path,
                source,
                ..
            } => {
                check_version(*version)?;
                valid_project_path(path)?;
                if source.len() > MAX_SOURCE_BYTES {
                    return Err("Source exceeds 1 MiB".into());
                }
                Ok(())
            }
            RuntimeClientMessage::FileRename {
                version,
                path,
                new_path,
                ..
            } => {
                check_version(*version)?;
                valid_project_path(path)?;
                valid_project_path(new_path)
            }
            RuntimeClientMessage::FileDelete { version, path, .. } => {
                check_version(*version)?;
                valid_project_path(path)
            }
            RuntimeClientMessage::RunRequest { version, .. } => check_version(*version),
            RuntimeClientMessage::RunCancel { .. } => Ok(()),
            RuntimeClientMessage::SettingsUpdate {
                debounce_ms,
                timeout_ms,
                manual_probe_ids,
                ..
            } => {
                if !(300..=500).contains(debounce_ms) {
                    return Err("debounceMs outside 300..500".into());
                }
                if !(100..=10_000).contains(timeout_ms) {
                    return Err("timeoutMs outside 100..10000".into());
                }
                if manual_probe_ids.len() > 1000
                    || manual_probe_ids
                        .iter()
                        .any(|id| id.is_empty() || id.len() > 128)
                {
                    return Err("invalid manualProbeIds".into());
                }
                Ok(())
            }
        }
    }
}

pub fn valid_project_path(value: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= 240
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.chars().any(|c| (c as u32) < 0x20)
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if ok {
        Ok(())
    } else {
        Err("Invalid project-relative path".into())
    }
}

// ── Server → client events ──

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    #[serde(rename = "run.state", rename_all = "camelCase")]
    RunStateEvent {
        document_version: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        state: RunState,
    },
    #[serde(rename = "project.files", rename_all = "camelCase")]
    ProjectFiles {
        document_version: u64,
        files: Vec<ProjectFile>,
    },
    #[serde(rename = "probe.catalog", rename_all = "camelCase")]
    ProbeCatalog {
        document_version: u64,
        probes: Vec<ProbeDescriptor>,
    },
    #[serde(rename = "test.catalog", rename_all = "camelCase")]
    TestCatalog {
        document_version: u64,
        tests: Vec<TestCase>,
    },
    #[serde(rename = "test.result", rename_all = "camelCase")]
    TestResult {
        document_version: u64,
        run_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        test_id: Option<String>,
        name: String,
        status: TestStatus,
        duration_ms: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "test.summary", rename_all = "camelCase")]
    TestSummary {
        document_version: u64,
        run_id: String,
        passed: u32,
        failed: u32,
        skipped: u32,
        leaked: u32,
        duration_ms: f64,
    },
    #[serde(rename = "probe_value", rename_all = "camelCase")]
    ProbeValue {
        protocol_version: u8,
        kind: &'static str,
        session_id: String,
        run_id: String,
        document_version: u64,
        probe_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        name: String,
        line: u32,
        column: u32,
        type_name: String,
        preview: String,
        truncated: bool,
        sequence: u64,
        timestamp: u64,
        count: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        bits: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        align_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fields: Option<Vec<ProbeFieldLayout>>,
    },
    #[serde(rename = "output", rename_all = "camelCase")]
    Output {
        document_version: u64,
        run_id: String,
        stream: Stream,
        category: OutputCategory,
        chunk: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_location: Option<LogSourceLocation>,
    },
    #[serde(rename = "diagnostics", rename_all = "camelCase")]
    Diagnostics {
        document_version: u64,
        owner: String,
        diagnostics: Vec<AppDiagnostic>,
    },
    #[serde(rename = "run.finished", rename_all = "camelCase")]
    RunFinished {
        document_version: u64,
        run_id: String,
        result: RunResult,
    },
    #[serde(rename = "server.error", rename_all = "camelCase")]
    ServerError {
        recoverable: bool,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputCategory {
    Program,
    Error,
}

// ── Default sources (byte-identical to packages/protocol) ──

pub const DEFAULT_ZIG_SOURCE: &str = r#"const std = @import("std");

pub fn main() void {
    const price: i32 = 40;
    const tax: i32 = 3;
    const total = price + tax;
    const values = [_]i32{ price, tax, total };

    _ = values;
}

fn applyTax(price: i32, tax: i32) i32 {
    return price + tax;
}

// Test blocks run after main(): check the tests panel →
test "applyTax adds the tax" {
    try std.testing.expectEqual(@as(i32, 43), applyTax(40, 3));
}

test "applyTax with zero tax" {
    try std.testing.expectEqual(@as(i32, 40), applyTax(40, 0));
}
"#;

pub const DEFAULT_RUST_SOURCE: &str = r#"fn main() {
    let price: i32 = 40;
    let tax: i32 = 3;
    let total = apply_tax(price, tax);
    let values = [price, tax, total];

    let _ = values;
}

fn apply_tax(price: i32, tax: i32) -> i32 {
    price + tax
}

// #[test] blocks run after main(): check the tests panel →
#[test]
fn apply_tax_adds_the_tax() {
    assert_eq!(43, apply_tax(40, 3));
}

#[test]
fn apply_tax_with_zero_tax() {
    assert_eq!(40, apply_tax(40, 0));
}
"#;

pub const DEFAULT_GO_SOURCE: &str = r#"package main

import "fmt"

func main() {
	price := 40
	tax := 3
	total := applyTax(price, tax)
	values := []int{price, tax, total}

	fmt.Println("total:", values[2])
}

func applyTax(price int, tax int) int {
	return price + tax
}
"#;

pub const DEFAULT_GO_TEST_SOURCE: &str = r#"package main

import "testing"

// TestXxx functions run after main(): check the tests panel →
func TestApplyTaxAddsTheTax(t *testing.T) {
	if applyTax(40, 3) != 43 {
		t.Fatalf("esperado 43, recibido %d", applyTax(40, 3))
	}
}

func TestApplyTaxWithZeroTax(t *testing.T) {
	if applyTax(40, 0) != 40 {
		t.Fatalf("esperado 40, recibido %d", applyTax(40, 0))
	}
}
"#;

pub const DEFAULT_TS_SOURCE: &str = r#"export function applyTax(price: number, tax: number): number {
	return price + tax;
}

const price: number = 40;
const tax: number = 3;
const total = applyTax(price, tax);
const values = [price, tax, total];

console.log("total:", values[2]);
"#;

pub const DEFAULT_TS_TEST_SOURCE: &str = r#"import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTax } from "./main.ts";

// node:test tests run after the program: check the panel →
test("applyTax adds the tax", () => {
	assert.equal(applyTax(40, 3), 43);
});

test("applyTax with zero tax", () => {
	assert.equal(applyTax(40, 0), 40);
});
"#;

pub const DEFAULT_PY_SOURCE: &str = r#"def apply_tax(price, tax):
    return price + tax


price = 40
tax = 3
total = apply_tax(price, tax)
values = [price, tax, total]

print("total:", values[2])
"#;

pub const DEFAULT_PY_TEST_SOURCE: &str = r#"from main import apply_tax


# test_* functions run after the program: check the panel →
def test_apply_tax_adds_the_tax():
    assert apply_tax(40, 3) == 43


def test_apply_tax_with_zero_tax():
    assert apply_tax(40, 0) == 40
"#;

pub const DEFAULT_C_SOURCE: &str = "#include <stdio.h>\n\nint apply_tax(int price, int tax) {\n\treturn price + tax;\n}\n\nint main(void) {\n\tint price = 40;\n\tint tax = 3;\n\tint total = apply_tax(price, tax);\n\tint values[3] = {price, tax, total};\n\n\tprintf(\"total: %d\\n\", values[2]);\n\treturn 0;\n}\n";

pub const DEFAULT_C_TEST_SOURCE: &str = "#include <assert.h>\n\nint apply_tax(int price, int tax);\n\n// test_* functions run after main(): check the tests panel →\nvoid test_apply_tax_adds_the_tax(void) {\n\tassert(apply_tax(40, 3) == 43);\n}\n\nvoid test_apply_tax_with_zero_tax(void) {\n\tassert(apply_tax(40, 0) == 40);\n}\n";

pub const DEFAULT_CPP_SOURCE: &str = "#include <iostream>\n#include <string>\n\nint apply_tax(int price, int tax) {\n\treturn price + tax;\n}\n\nint main() {\n\tint price = 40;\n\tint tax = 3;\n\tint total = apply_tax(price, tax);\n\tstd::string label = \"total\";\n\n\tstd::cout << label << \": \" << total << \"\\n\";\n\treturn 0;\n}\n";

pub const DEFAULT_CPP_TEST_SOURCE: &str = "#include <cassert>\n\nint apply_tax(int price, int tax);\n\n// test_* functions run after main(): check the tests panel →\nvoid test_apply_tax_adds_the_tax() {\n\tassert(apply_tax(40, 3) == 43);\n}\n\nvoid test_apply_tax_with_zero_tax() {\n\tassert(apply_tax(40, 0) == 40);\n}\n";
