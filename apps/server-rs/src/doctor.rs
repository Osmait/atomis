//! /api/doctor mirrored from doctor.ts: informative toolchain checks plus a
//! native compile/run, temp-storage and fd-3 smoke test.

#![allow(dead_code)]

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DoctorCheck {
    pub name: String,
    pub ok: bool,
    pub detected: String,
    pub expected: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

async fn command(
    command: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
) -> (Option<i32>, String, String) {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    match cmd.output().await {
        Ok(output) => (
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ),
        Err(error) => (None, String::new(), error.to_string()),
    }
}

pub async fn run_doctor() -> Vec<DoctorCheck> {
    let mut checks = Vec::new();

    // The Node.js check becomes informative: the Rust server does not need
    // Node itself, but the TS/C instrumenters and TS sessions spawn `node`.
    let (code, stdout, stderr) = command("node", &["--version"], None).await;
    let detected = if stdout.trim().is_empty() {
        if stderr.trim().is_empty() {
            "not found".to_string()
        } else {
            stderr.trim().to_string()
        }
    } else {
        stdout.trim().to_string()
    };
    let node_major: u32 = detected
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    checks.push(DoctorCheck {
        name: "Node.js".to_string(),
        ok: code == Some(0) && (22..25).contains(&node_major),
        detected: detected.trim_start_matches('v').to_string(),
        expected: "22.x production baseline (22–24 accepted for development)".to_string(),
        command: "node --version".to_string(),
        help: Some("Install Node 22, then run: corepack enable && pnpm run doctor".to_string()),
    });

    for tool in ["zig", "zls"] {
        let args: &[&str] = if tool == "zig" {
            &["version"]
        } else {
            &["--version"]
        };
        let (code, stdout, stderr) = command(tool, args, None).await;
        let detected = if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            "not found".to_string()
        };
        checks.push(DoctorCheck {
            name: if tool == "zig" {
                "Zig compiler".to_string()
            } else {
                "ZLS language server".to_string()
            },
            ok: code == Some(0) && detected.starts_with("0.16."),
            detected,
            expected: "0.16.x".to_string(),
            command: format!("{tool} {}", args.join(" ")),
            help: Some(format!(
                "Install {tool} 0.16.x on PATH. ZigLive never downloads it automatically."
            )),
        });
    }

    let optional: [(&str, &str, &str); 11] = [
        ("Rust", "rustc", "1.75+ (optional, enables Rust sessions)"),
        ("Rust", "cargo", "1.75+ (optional, enables Rust sessions)"),
        (
            "Rust",
            "rust-analyzer",
            "any (optional, enables Rust editor features)",
        ),
        ("Go", "go", "1.22+ (optional, enables Go sessions)"),
        ("Go", "gopls", "any (optional, enables Go editor features)"),
        (
            "TS",
            "typescript-language-server",
            "any (optional, enables TS/JS editor features)",
        ),
        ("Python", "python3", "3.9+ (optional, enables Python sessions)"),
        (
            "Python",
            "pyright-langserver",
            "any (optional, enables Python editor features)",
        ),
        ("C/C++", "clang", "15+ (optional, enables C sessions)"),
        ("C/C++", "clang++", "15+ (optional, enables C++ sessions)"),
        (
            "C/C++",
            "clangd",
            "any (optional, enables C/C++ editor features)",
        ),
    ];
    for (group, tool, expected) in optional {
        let args: &[&str] = if tool == "go" {
            &["version"]
        } else {
            &["--version"]
        };
        let (code, stdout, stderr) = command(tool, args, None).await;
        let first_line = stdout.trim().lines().next().unwrap_or("").to_string();
        let detected = if !first_line.is_empty() {
            first_line
        } else if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            "not found".to_string()
        };
        checks.push(DoctorCheck {
            name: format!("{group} {tool}"),
            ok: true,
            detected: if code == Some(0) {
                detected
            } else {
                format!("{detected} — {group} support degraded")
            },
            expected: expected.to_string(),
            command: format!("{tool} {}", args.join(" ")),
            help: None,
        });
    }

    // Native compile/run + writable temp storage.
    let directory = std::env::temp_dir().join(format!(
        "ziglive-doctor-{}",
        crate::util::random_hex(6)
    ));
    let _ = tokio::fs::create_dir_all(&directory).await;
    let _ = tokio::fs::write(directory.join("main.zig"), "pub fn main() void {}\n").await;
    let (compile_code, _, compile_stderr) = command(
        "zig",
        &["build-exe", "main.zig", "-femit-bin=doctor-bin"],
        Some(&directory),
    )
    .await;
    let execute = if compile_code == Some(0) {
        command(
            &directory.join("doctor-bin").to_string_lossy(),
            &[],
            Some(&directory),
        )
        .await
    } else {
        (None, String::new(), "compile failed".to_string())
    };
    checks.push(DoctorCheck {
        name: "Native compile/run".to_string(),
        ok: compile_code == Some(0) && execute.0 == Some(0),
        detected: if compile_code == Some(0) {
            format!("exit {:?}", execute.0.unwrap_or(-1))
        } else {
            compile_stderr.trim().to_string()
        },
        expected: "temporary binary exits 0".to_string(),
        command: "zig build-exe main.zig -femit-bin=doctor-bin".to_string(),
        help: Some("Check compiler/linker availability and executable temp mounts.".to_string()),
    });
    let writable = tokio::fs::write(directory.join(".probe"), "x").await.is_ok();
    checks.push(DoctorCheck {
        name: "Temporary storage".to_string(),
        ok: writable,
        detected: directory.to_string_lossy().to_string(),
        expected: "writable".to_string(),
        command: format!("test -w {}", directory.to_string_lossy()),
        help: None,
    });

    // Probe descriptor fd 3 through the supervisor's own pipe machinery.
    let probe_result = {
        use crate::supervisor::{run, ProcessLimits, RunOptions, StreamCallbacks};
        use std::sync::{Arc, Mutex};
        let script = directory.join("fd3.sh");
        let _ = tokio::fs::write(&script, "#!/bin/sh\nprintf 'probe\\n' >&3\n").await;
        let _ = command("chmod", &["+x", &script.to_string_lossy()], None).await;
        let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&captured);
        let result = run(
            &script.to_string_lossy(),
            &[],
            RunOptions {
                cwd: directory.clone(),
                limits: ProcessLimits::new(3000, 65536, 65536),
                cancel: tokio_util::sync::CancellationToken::new(),
                probe_fd: true,
                env: Vec::new(),
                callbacks: StreamCallbacks {
                    stdout: None,
                    stderr: None,
                    probe: Some(Box::new(move |chunk: &[u8]| {
                        sink.lock().expect("probe sink").extend_from_slice(chunk);
                    })),
                },
            },
        )
        .await;
        let probe = String::from_utf8_lossy(&captured.lock().expect("probe sink")).to_string();
        (result.exit_code, probe)
    };
    checks.push(DoctorCheck {
        name: "Probe descriptor fd 3".to_string(),
        ok: probe_result.0 == Some(0) && probe_result.1 == "probe\n",
        detected: format!(
            "{{\"code\":{:?},\"probe\":{:?}}}",
            probe_result.0, probe_result.1
        ),
        expected: "separate inherited pipe".to_string(),
        command: "sh fd3.sh (fd 3 = pipe)".to_string(),
        help: None,
    });
    let _ = tokio::fs::remove_dir_all(&directory).await;
    checks
}
