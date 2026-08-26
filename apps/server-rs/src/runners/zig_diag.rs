//! Zig compiler diagnostics + test discovery, mirrored from
//! DiagnosticMapper.ts and TestDiscovery.ts.

#![allow(dead_code)]

use regex::Regex;
use std::sync::OnceLock;

use crate::protocol::{AppDiagnostic, ProjectFile, Severity, TestCase};

fn compiler_location() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(.*\.zig):(\d+):(\d+): (error|warning|note): (.+)$").expect("static regex")
    })
}

fn location_anywhere() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"([^\s:]*\.zig):(\d+):(\d+)").expect("static regex"))
}

fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => ".",
    }
}

fn generated_path_aliases(generated_path: &str) -> Vec<String> {
    let normalized = generated_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    let relative = if parts.len() >= 2 {
        parts[parts.len() - 2..].join("/")
    } else {
        normalized.clone()
    };
    if relative == normalized {
        vec![normalized]
    } else {
        vec![normalized, relative]
    }
}

fn generated_project_path(path: &str, generated_path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let root = dirname(generated_path).replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix(&format!("{root}/")) {
        return Some(format!("src/{rest}"));
    }
    let source_root = format!("{}/src", dirname(&root));
    if let Some(rest) = normalized.strip_prefix(&format!("{source_root}/")) {
        return Some(format!("src/{rest}"));
    }
    if normalized.starts_with("src/") && !normalized.contains("..") {
        return Some(normalized);
    }
    let marker = "generated/";
    if let Some(index) = normalized.rfind(marker) {
        return Some(format!("src/{}", &normalized[index + marker.len()..]));
    }
    if generated_path_aliases(generated_path).contains(&normalized) {
        let file = normalized.split('/').next_back().unwrap_or("main.zig");
        return Some(format!("src/{file}"));
    }
    None
}

struct Reference {
    path: String,
    line: u32,
    column: u32,
}

fn generated_reference(line: &str, generated_path: &str) -> Option<Reference> {
    for capture in location_anywhere().captures_iter(line) {
        let path = capture.get(1)?.as_str();
        let line_text = capture.get(2)?.as_str();
        let column_text = capture.get(3)?.as_str();
        if let Some(project_path) = generated_project_path(path, generated_path) {
            return Some(Reference {
                path: project_path,
                line: line_text.parse().ok()?,
                column: column_text.parse().ok()?,
            });
        }
    }
    None
}

fn find_generated_reference(
    lines: &[&str],
    start_index: usize,
    generated_path: &str,
) -> Option<Reference> {
    for line in lines.iter().skip(start_index) {
        if let Some(capture) = compiler_location().captures(line) {
            let level = capture.get(4).map(|m| m.as_str());
            if level == Some("error") || level == Some("warning") {
                return None;
            }
        }
        if let Some(reference) = generated_reference(line, generated_path) {
            return Some(reference);
        }
    }
    None
}

fn compiler_severity(level: &str) -> Severity {
    match level {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        _ => Severity::Information,
    }
}

pub fn parse_compiler_diagnostics(stderr: &str, generated_path: &str) -> Vec<AppDiagnostic> {
    let mut diagnostics = Vec::new();
    let lines: Vec<&str> = stderr.split(['\n']).map(|l| l.trim_end_matches('\r')).collect();
    for (index, line) in lines.iter().enumerate() {
        let Some(capture) = compiler_location().captures(line) else {
            continue;
        };
        let path = capture.get(1).map(|m| m.as_str()).unwrap_or_default();
        let line_text = capture.get(2).map(|m| m.as_str()).unwrap_or_default();
        let column_text = capture.get(3).map(|m| m.as_str()).unwrap_or_default();
        let level = capture.get(4).map(|m| m.as_str()).unwrap_or_default();
        let message = capture.get(5).map(|m| m.as_str()).unwrap_or_default();
        let project_path = generated_project_path(path, generated_path);
        let reference = if project_path.is_some() {
            None
        } else {
            find_generated_reference(&lines, index + 1, generated_path)
        };
        let diagnostic_path = reference
            .as_ref()
            .map(|r| r.path.clone())
            .or_else(|| project_path.clone());
        diagnostics.push(AppDiagnostic {
            message: if project_path.is_some() {
                message.to_string()
            } else {
                format!("{message} ({path})")
            },
            path: diagnostic_path,
            severity: compiler_severity(level),
            line: reference
                .as_ref()
                .map(|r| r.line)
                .unwrap_or_else(|| line_text.parse().unwrap_or(1)),
            column: reference
                .as_ref()
                .map(|r| r.column)
                .unwrap_or_else(|| column_text.parse().unwrap_or(1)),
            end_line: None,
            end_column: None,
            code: None,
            source: Some("zig".to_string()),
        });
    }
    dedupe(diagnostics)
}

pub fn dedupe(diagnostics: Vec<AppDiagnostic>) -> Vec<AppDiagnostic> {
    let mut seen = std::collections::HashSet::new();
    diagnostics
        .into_iter()
        .filter(|d| {
            let key = format!(
                "{}:{}:{}:{:?}:{}",
                d.path.as_deref().unwrap_or(""),
                d.line,
                d.column,
                d.severity,
                d.message
            );
            seen.insert(key)
        })
        .collect()
}

// ── Test discovery (TestDiscovery.ts) ──

fn string_test() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^(\s*)test\s+"((?:[^"\\]|\\.)*)""#).expect("static regex"))
}

fn decl_test() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\s*)test\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{").expect("static regex"))
}

fn unescape_title(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Finds `test "…"` and `test identifier {` blocks in the visible sources.
pub fn discover_tests(files: &[ProjectFile]) -> Vec<TestCase> {
    let mut tests = Vec::new();
    for file in files {
        if !file.path.ends_with(".zig") {
            continue;
        }
        for (index, line) in file.source.split('\n').enumerate() {
            let string_match = string_test().captures(line);
            let decl_match = if string_match.is_some() {
                None
            } else {
                decl_test().captures(line)
            };
            let Some(capture) = string_match.as_ref().or(decl_match.as_ref()) else {
                continue;
            };
            let indent = capture.get(1).map(|m| m.as_str().len()).unwrap_or(0);
            let title = capture.get(2).map(|m| m.as_str()).unwrap_or_default();
            tests.push(TestCase {
                test_id: format!("{}:{}", file.path, index + 1),
                path: format!("src/{}", file.path),
                name: if string_match.is_some() {
                    unescape_title(title)
                } else {
                    title.to_string()
                },
                line: (index + 1) as u32,
                column: (indent + 1) as u32,
            });
        }
    }
    tests
}

/// Maps a runner-reported qualified name back to a discovered test case.
pub fn match_runner_name<'a>(catalog: &'a [TestCase], runner_name: &str) -> Option<&'a TestCase> {
    const MARKER: &str = ".test.";
    let expected_prefix = |path: &str| -> String {
        path.strip_suffix(".zig")
            .unwrap_or(path)
            .replace('/', ".")
    };
    let mut marker_index = runner_name.find(MARKER);
    while let Some(index) = marker_index {
        let prefix = &runner_name[..index];
        let title = &runner_name[index + MARKER.len()..];
        if let Some(matched) = catalog
            .iter()
            .find(|c| expected_prefix(&c.path) == prefix && c.name == title)
        {
            return Some(matched);
        }
        marker_index = runner_name[index + 1..]
            .find(MARKER)
            .map(|next| index + 1 + next);
    }
    let fallback_title = match runner_name.find(MARKER) {
        Some(index) => &runner_name[index + MARKER.len()..],
        None => runner_name.split('.').next_back().unwrap_or(runner_name),
    };
    catalog.iter().find(|c| c.name == fallback_title)
}
