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

use crate::packs;
use crate::protocol::Language;
use crate::session::Session;

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
    child: Option<tokio::process::Child>,
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
                child: None,
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
        tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                match message {
                    Message::Text(text) => {
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
        let child = tokio::process::Command::new(command)
            .args(&args)
            .current_dir(&self.session.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
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
                        "method": "ziglive/lspRestarted",
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

    async fn close(&self) {
        let mut state = self.state.lock().await;
        state.closing = true;
        if let Some(stdin) = state.child_stdin.as_mut() {
            let shutdown = serde_json::json!({
                "jsonrpc": "2.0",
                "id": "ziglive-shutdown",
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
        if let Some(mut child) = state.child.take() {
            let _ = child.start_kill();
        }
        state.child_stdin = None;
        state.socket = None;
    }
}
