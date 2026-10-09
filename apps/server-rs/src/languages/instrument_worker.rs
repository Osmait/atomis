//! Long-lived instrumenter processes, one per script, shared by sessions.
//!
//! A Node instrumenter spends ~110 ms loading its parser and a few ms
//! instrumenting; spawned per file, that load is most of a TS run's
//! instrumentation time. The worker (`ts/instrumenter/worker.mjs`) loads it
//! once and answers JSON-line requests. It is given source text and returns
//! generated text, never opening a file, so it needs no per-session sandbox:
//! the files are read and written here, as the session would have.
//!
//! Any failure — a crash, a malformed answer, a timeout — drops the worker
//! and returns `None`, and the caller instruments the classic way; the next
//! request starts a fresh worker.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

/// Far above a normal answer (single-digit ms); a stuck parse is dropped.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

struct Worker {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

static WORKERS: LazyLock<Mutex<HashMap<PathBuf, Worker>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<'a> {
    pub source: &'a str,
    pub uri: &'a str,
    pub version: u64,
    pub file_id: u32,
    pub auto_inspect: bool,
    pub manual: &'a [String],
    pub output: &'a str,
    pub source_map: &'a str,
}

pub struct Answer {
    /// What the CLI prints on stdout.
    pub json: String,
    /// The instrumented source, absent when the input did not parse.
    pub generated: Option<String>,
}

#[derive(serde::Deserialize)]
struct Wire {
    id: Option<u64>,
    json: Option<String>,
    generated: Option<String>,
    error: Option<String>,
}

/// Instruments one file through the worker for `script`; `None` means
/// "use the CLI instead".
pub async fn instrument(script: &Path, request: &Request<'_>) -> Option<Answer> {
    let mut workers = WORKERS.lock().await;
    if !workers.contains_key(script) {
        match spawn(script) {
            Ok(worker) => {
                workers.insert(script.to_path_buf(), worker);
            }
            Err(error) => {
                tracing::warn!(%error, "instrumenter worker failed to start");
                return None;
            }
        }
    }
    let worker = workers.get_mut(script)?;
    match tokio::time::timeout(ANSWER_TIMEOUT, exchange(worker, request)).await {
        Ok(Ok(answer)) => Some(answer),
        Ok(Err(error)) => {
            tracing::warn!(%error, "instrumenter worker failed; using the CLI");
            workers.remove(script);
            None
        }
        Err(_) => {
            tracing::warn!("instrumenter worker timed out; using the CLI");
            workers.remove(script);
            None
        }
    }
}

fn spawn(script: &Path) -> Result<Worker, String> {
    let mut command = tokio::process::Command::new("node");
    crate::exec::supervisor::scrub_bundle_env(&mut command);
    command
        .arg(script)
        .current_dir(script.parent().unwrap_or(Path::new("/")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "linux")]
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
    Ok(Worker { _child: child, stdin, stdout, next_id: 0 })
}

async fn exchange(worker: &mut Worker, request: &Request<'_>) -> Result<Answer, String> {
    worker.next_id += 1;
    let id = worker.next_id;
    let mut line = serde_json::to_value(request).map_err(|error| error.to_string())?;
    line["id"] = id.into();
    let mut bytes = line.to_string().into_bytes();
    bytes.push(b'\n');
    worker.stdin.write_all(&bytes).await.map_err(|error| error.to_string())?;
    worker.stdin.flush().await.map_err(|error| error.to_string())?;
    let mut answer = String::new();
    if worker.stdout.read_line(&mut answer).await.map_err(|error| error.to_string())? == 0 {
        return Err("worker exited".to_string());
    }
    let wire: Wire = serde_json::from_str(&answer).map_err(|error| error.to_string())?;
    if wire.id != Some(id) {
        return Err(format!("answer for {:?}, expected {id}", wire.id));
    }
    if let Some(error) = wire.error {
        return Err(error);
    }
    Ok(Answer {
        json: wire.json.ok_or("answer without json")?,
        generated: wire.generated,
    })
}
