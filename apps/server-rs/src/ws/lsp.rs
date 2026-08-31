//! /ws/lsp proxy mirrored from LspProxy.ts + LspFramer.ts: bridges the
//! browser WebSocket to a stdio language server with Content-Length framing,
//! one restart on crash, and the zig observed-unused diagnostic filter.

#![allow(dead_code)]

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::languages::packs;
use crate::protocol::Language;
use crate::domain::session::Session;

const MAX_LSP_MESSAGE: usize = 8 * 1024 * 1024;

pub struct LspFramer {
    buffer: Vec<u8>,
    expected_body: Option<usize>,
}

impl LspFramer {
    pub fn new() -> Self {
        LspFramer {
            buffer: Vec::new(),
            expected_body: None,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            if self.expected_body.is_none() {
                let Some(end) = find_header_end(&self.buffer) else {
                    if self.buffer.len() > 8192 {
                        return Err("LSP header exceeds 8 KiB".into());
                    }
                    break;
                };
                let header = String::from_utf8_lossy(&self.buffer[..end]).to_string();
                self.buffer.drain(..end + 4);
                let lengths: Vec<&str> = header
                    .split("\r\n")
                    .filter(|line| line.to_lowercase().starts_with("content-length:"))
                    .collect();
                if lengths.len() != 1 {
                    return Err("LSP frame must contain one Content-Length header".into());
                }
                let raw = lengths[0]
                    .split(':')
                    .nth(1)
                    .map(str::trim)
                    .unwrap_or_default();
                let length: usize = raw
                    .parse()
                    .map_err(|_| "Invalid LSP Content-Length".to_string())?;
                if length == 0 || length > MAX_LSP_MESSAGE {
                    return Err(format!("LSP body length {raw} is outside the limit"));
                }
                self.expected_body = Some(length);
            }
            let expected = self.expected_body.unwrap_or(0);
            if self.buffer.len() < expected {
                break;
            }
            let body: Vec<u8> = self.buffer.drain(..expected).collect();
            self.expected_body = None;
            let value: Value = serde_json::from_slice(&body)
                .map_err(|error| format!("Invalid LSP JSON: {error}"))?;
            messages.push(value);
        }
        Ok(messages)
    }

    pub fn frame(message: &Value) -> Vec<u8> {
        let body = serde_json::to_vec(message).unwrap_or_default();
        let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(&body);
        out
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

// ── observed-unused filter (DiagnosticMapper.ts) ──

const EXACT_UNUSED: [&str; 3] = [
    "unused local constant",
    "unused local variable",
    "unused function parameter",
];
const UNUSED_CODES: [&str; 3] = ["unused_local", "unused-local", "unused_local_variable"];

fn filter_observed_unused(
    diagnostics: &[Value],
    probes: &[crate::protocol::ProbeDescriptor],
) -> Vec<Value> {
    diagnostics
        .iter()
        .filter(|diagnostic| {
            let code_matches = diagnostic.get("code").is_some_and(|code| match code {
                Value::String(text) => UNUSED_CODES.contains(&text.as_str()),
                Value::Number(_) => false,
                _ => false,
            });
            let message_matches = if diagnostic.get("code").is_some() {
                code_matches
            } else {
                diagnostic
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|m| EXACT_UNUSED.contains(&m.trim().to_lowercase().as_str()))
                    .unwrap_or(false)
            };
            if !message_matches {
                return true;
            }
            let Some(start) = diagnostic
                .get("range")
                .and_then(|r| r.get("start"))
            else {
                return true;
            };
            let (Some(line), Some(character)) = (
                start.get("line").and_then(Value::as_u64),
                start.get("character").and_then(Value::as_u64),
            ) else {
                return true;
            };
            !probes.iter().any(|probe| {
                probe.supported
                    && probe.insertion_byte.is_some()
                    && u64::from(probe.original_range.start_line) - 1 == line
                    && character >= u64::from(probe.original_range.start_column) - 1
                    && character < u64::from(probe.original_range.end_column)
            })
        })
        .cloned()
        .collect()
}

// ── proxy ──

pub struct LspRegistry {
    proxies: Mutex<HashMap<String, Arc<LspProxy>>>,
}

impl LspRegistry {
    pub fn new() -> Self {
        LspRegistry {
            proxies: Mutex::new(HashMap::new()),
        }
    }

    pub async fn register_session(&self, _session_id: &str) {}

    pub async fn attach(
        &self,
        session: Arc<Session>,
        language: Language,
        socket: WebSocket,
    ) {
        let key = format!("{}:{}", session.id, language.as_str());
        let proxy = {
            let mut proxies = self.proxies.lock().await;
            Arc::clone(proxies.entry(key).or_insert_with(|| {
                Arc::new(LspProxy::new(session, language))
            }))
        };
        proxy.attach(socket).await;
    }

    pub async fn close_session(&self, session_id: &str) {
        let keys: Vec<String> = {
            let proxies = self.proxies.lock().await;
            proxies
                .keys()
                .filter(|key| key.starts_with(&format!("{session_id}:")))
                .cloned()
                .collect()
        };
        for key in keys {
            let proxy = self.proxies.lock().await.remove(&key);
            if let Some(proxy) = proxy {
                proxy.close().await;
            }
        }
    }
}

type WsSink = futures_util::stream::SplitSink<WebSocket, Message>;

struct ProxyState {
    child_stdin: Option<tokio::process::ChildStdin>,
    socket: Option<Arc<Mutex<WsSink>>>,
    restarts: u32,
    closing: bool,
    reader_task: Option<tokio::task::JoinHandle<()>>,
    /// The task pumping the CURRENT websocket into child stdin. Aborted when
    /// a newer socket attaches, so a lingering reconnect cannot interleave
    /// its frames into the same stdin.
    socket_task: Option<tokio::task::JoinHandle<()>>,
    child: Option<tokio::process::Child>,
    /// The child's pid, held for `close()`: the exit watcher owns the
    /// `Child` itself (it is parked in `wait()`), so a shutdown that the
    /// server ignores can only be enforced by signalling the pid directly.
    /// Cleared by the watcher once the process is reaped, after which the
    /// pid may belong to someone else and must not be signalled.
    child_pid: Option<i32>,
}

pub struct LspProxy {
    session: Arc<Session>,
    language: Language,
    state: Mutex<ProxyState>,
}

impl LspProxy {
    fn new(session: Arc<Session>, language: Language) -> Self {
        LspProxy {
            session,
            language,
            state: Mutex::new(ProxyState {
                child_stdin: None,
                socket: None,
                restarts: 0,
                closing: false,
                reader_task: None,
                socket_task: None,
                child: None,
                child_pid: None,
            }),
        }
    }

    async fn send_socket(state: &Mutex<ProxyState>, text: String) {
        let socket = state.lock().await.socket.clone();
        if let Some(socket) = socket {
            let _ = socket.lock().await.send(Message::Text(text.into())).await;
        }
    }

    async fn attach(self: &Arc<Self>, socket: WebSocket) {
        let (sink, mut stream) = socket.split();
        let sink = Arc::new(Mutex::new(sink));
        {
            let mut state = self.state.lock().await;
            state.socket = Some(Arc::clone(&sink));
            let needs_start = state.child.is_none() && state.child_stdin.is_none();
            drop(state);
            if needs_start {
                Arc::clone(self).start_boxed().await;
            }
        }
        let proxy = Arc::clone(self);
        let pump = tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                match message {
                    Message::Text(text) => {
                        // The runtime socket bounds its messages; this one
                        // feeds a child process and gets the same courtesy.
                        if text.len() > MAX_LSP_MESSAGE {
                            break;
                        }
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            break;
                        };
                        if !value.is_object() {
                            break;
                        }
                        let mut state = proxy.state.lock().await;
                        if let Some(stdin) = state.child_stdin.as_mut() {
                            let _ = stdin.write_all(&LspFramer::frame(&value)).await;
                        }
                    }
                    Message::Binary(_) => break,
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        // Socket and pump swap together under one lock: a reconnect replaces
        // both, and the previous socket's pump stops writing into the shared
        // stdin — interleaved, only the newest client saw any response.
        let mut state = self.state.lock().await;
        state.socket = Some(sink);
        if let Some(previous) = state.socket_task.replace(pump) {
            previous.abort();
        }
    }

    fn start_boxed(self: Arc<Self>) -> futures_util::future::BoxFuture<'static, ()> {
        Box::pin(async move { self.start_inner().await })
    }

    async fn start_inner(self: Arc<Self>) {
        let this = &self;
        this.start_impl().await;
    }

    async fn start_impl(self: &Arc<Self>) {
        let pack = packs::pack(self.language);
        let Some(command) = pack.lsp_command else {
            return;
        };
        let args = packs::lsp_args(self.language, &self.session.root);
        let mut builder = tokio::process::Command::new(command);
        // A language server is a system tool too: an inherited bundle path
        // would break it the same way it breaks a compiler.
        crate::exec::supervisor::scrub_bundle_env(&mut builder);
        builder
            .args(&args)
            .current_dir(&self.session.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // kill_on_drop covers the ordinary path, where closing the socket
        // drops the child. It cannot help if we exit without unwinding, so
        // ask the kernel to take the language server down with us as well —
        // one syscall, safe to make between fork and exec.
        #[cfg(target_os = "linux")]
        unsafe {
            builder.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        let child = builder.spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                Self::send_socket(
                    &self.state,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "window/showMessage",
                        "params": { "type": 1, "message": format!("Language server unavailable: {error}") },
                    })
                    .to_string(),
                )
                .await;
                return;
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut state = self.state.lock().await;
            state.child_stdin = stdin;
        }

        if let Some(mut stderr) = stderr {
            let command_name = command.to_string();
            let session_id = self.session.id.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 8192];
                while let Ok(n) = stderr.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buffer[..n]);
                    tracing::warn!(component = %command_name, session = %session_id, "{}", chunk.trim());
                }
            });
        }

        let proxy = Arc::clone(self);
        let reader = tokio::spawn(async move {
            let Some(mut stdout) = stdout else { return };
            let mut framer = LspFramer::new();
            let mut buffer = [0u8; 64 * 1024];
            while let Ok(n) = stdout.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                match framer.push(&buffer[..n]) {
                    Ok(messages) => {
                        for message in messages {
                            proxy.forward(message).await;
                        }
                    }
                    Err(error) => {
                        Self::send_socket(
                            &proxy.state,
                            serde_json::json!({
                                "jsonrpc": "2.0",
                                "method": "window/showMessage",
                                "params": { "type": 1, "message": format!("Invalid ZLS framing: {error}") },
                            })
                            .to_string(),
                        )
                        .await;
                        break;
                    }
                }
            }
        });

        {
            let mut state = self.state.lock().await;
            state.reader_task = Some(reader);
            state.child_pid = child.id().map(|pid| pid as i32);
            state.child = Some(child);
        }

        // Watch for exit and restart once.
        let proxy = Arc::clone(self);
        tokio::spawn(async move {
            let child = {
                let mut state = proxy.state.lock().await;
                state.child.take()
            };
            let Some(mut child) = child else { return };
            let _ = child.wait().await;
            let mut state = proxy.state.lock().await;
            state.child_stdin = None;
            // Reaped: from here the pid may be reused and must not be
            // signalled by anyone.
            state.child_pid = None;
            if state.closing {
                return;
            }
            let restarts = state.restarts;
            state.restarts += 1;
            drop(state);
            if restarts == 0 {
                Arc::clone(&proxy).start_boxed().await;
                Self::send_socket(
                    &proxy.state,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "atomis/lspRestarted",
                        "params": {},
                    })
                    .to_string(),
                )
                .await;
            } else {
                Self::send_socket(
                    &proxy.state,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "window/showMessage",
                        "params": { "type": 1, "message": "Language server stopped twice; editor continues in degraded mode." },
                    })
                    .to_string(),
                )
                .await;
            }
        });
    }

    async fn forward(&self, mut message: Value) {
        if message.get("method").and_then(Value::as_str)
            == Some("textDocument/publishDiagnostics")
            && self.language == Language::Zig
        {
            let uri = message
                .get("params")
                .and_then(|p| p.get("uri"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let diagnostics = message
                .get("params")
                .and_then(|p| p.get("diagnostics"))
                .and_then(Value::as_array)
                .cloned();
            if let Some(diagnostics) = diagnostics {
                let snapshot = self.session.current().await;
                let project_path = uri.and_then(|uri| {
                    snapshot
                        .files
                        .iter()
                        .find(|f| f.uri == uri)
                        .map(|f| format!("src/{}", f.path))
                });
                let probes = self.session.probes.lock().await;
                let relevant: Vec<crate::protocol::ProbeDescriptor> = probes
                    .iter()
                    .filter(|probe| {
                        probe.path.is_none() || probe.path.as_deref() == project_path.as_deref()
                    })
                    .cloned()
                    .collect();
                let filtered = filter_observed_unused(&diagnostics, &relevant);
                if let Some(params) = message.get_mut("params") {
                    params["diagnostics"] = Value::Array(filtered);
                }
            }
        }
        Self::send_socket(&self.state, message.to_string()).await;
    }

    async fn close(self: &Arc<Self>) {
        let mut state = self.state.lock().await;
        state.closing = true;
        if let Some(stdin) = state.child_stdin.as_mut() {
            let shutdown = serde_json::json!({
                "jsonrpc": "2.0",
                "id": "atomis-shutdown",
                "method": "shutdown",
                "params": null,
            });
            let _ = stdin.write_all(&LspFramer::frame(&shutdown)).await;
            let exit = serde_json::json!({ "jsonrpc": "2.0", "method": "exit", "params": null });
            let _ = stdin.write_all(&LspFramer::frame(&exit)).await;
        }
        if let Some(task) = state.reader_task.take() {
            task.abort();
        }
        if let Some(task) = state.socket_task.take() {
            task.abort();
        }
        // The exit watcher owns the `Child` (it is parked in wait()), so
        // this take() is a dead letter on the ordinary path — the pid is
        // what can still be enforced. Polite first; a server that ignores
        // `exit` gets SIGKILL, checked against the watcher having reaped.
        if let Some(mut child) = state.child.take() {
            let _ = child.start_kill();
        }
        if let Some(pid) = state.child_pid {
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            let proxy = Arc::clone(self);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let state = proxy.state.lock().await;
                if state.child_pid == Some(pid) {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            });
        }
        state.child_stdin = None;
        state.socket = None;
    }
}

#[cfg(test)]
mod framer_tests {
    use super::*;

    fn framed(body: &str) -> Vec<u8> {
        let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(body.as_bytes());
        out
    }

    #[test]
    fn a_message_arrives_whole_or_in_any_number_of_pieces() {
        let bytes = framed(r#"{"jsonrpc":"2.0","method":"x"}"#);
        // Whole.
        let mut framer = LspFramer::new();
        assert_eq!(framer.push(&bytes).unwrap().len(), 1);
        // One byte at a time, headers included.
        let mut framer = LspFramer::new();
        let mut seen = 0;
        for byte in &bytes {
            seen += framer.push(std::slice::from_ref(byte)).unwrap().len();
        }
        assert_eq!(seen, 1);
    }

    #[test]
    fn a_multibyte_body_split_between_chunks_still_parses() {
        let bytes = framed(r#"{"m":"señor 🎉"}"#);
        // Split inside the emoji's four bytes.
        let cut = bytes.len() - 3;
        let mut framer = LspFramer::new();
        assert_eq!(framer.push(&bytes[..cut]).unwrap().len(), 0);
        let messages = framer.push(&bytes[cut..]).unwrap();
        assert_eq!(messages[0]["m"], "señor 🎉");
    }

    #[test]
    fn two_messages_in_one_chunk_both_come_out() {
        let mut bytes = framed(r#"{"a":1}"#);
        bytes.extend_from_slice(&framed(r#"{"b":2}"#));
        let mut framer = LspFramer::new();
        assert_eq!(framer.push(&bytes).unwrap().len(), 2);
    }

    #[test]
    fn malformed_framing_is_an_error_not_a_hang() {
        // Not a number.
        let mut framer = LspFramer::new();
        assert!(framer.push(b"Content-Length: nope\r\n\r\n{}").is_err());
        // Zero, absent, doubled, and beyond the limit.
        let mut framer = LspFramer::new();
        assert!(framer.push(b"Content-Length: 0\r\n\r\n").is_err());
        let mut framer = LspFramer::new();
        assert!(framer.push(b"Content-Type: json\r\n\r\n{}").is_err());
        let mut framer = LspFramer::new();
        assert!(framer
            .push(b"Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}x")
            .is_err());
        let mut framer = LspFramer::new();
        let huge = format!("Content-Length: {}\r\n\r\n", MAX_LSP_MESSAGE + 1);
        assert!(framer.push(huge.as_bytes()).is_err());
        // A body that is not JSON.
        let mut framer = LspFramer::new();
        assert!(framer.push(b"Content-Length: 3\r\n\r\nnop").is_err());
    }

    #[test]
    fn an_unbounded_header_is_refused() {
        let mut framer = LspFramer::new();
        // No \r\n\r\n in sight and past the 8KB cap: refuse, do not buffer
        // forever.
        assert!(framer.push(&vec![b'a'; 9000]).is_err());
    }
}
