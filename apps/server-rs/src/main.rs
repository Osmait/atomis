//! Atomis backend (Rust rewrite): axum server with the same HTTP + WS
//! contract as apps/server. The Node sidecar stays the reference
//! implementation until the Playwright e2e suite passes against this binary.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;

mod deps;
mod doctor;
mod markers;
mod ndjson;
mod packs;
mod preferences;
mod protocol;
mod runners;
mod sandbox;
mod scheduler;
mod session;
mod state;
mod supervisor;
mod util;
mod workspace;
mod ws_lsp;
mod ws_runtime;

use protocol::Language;
use state::AppState;

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "host": "127.0.0.1" }))
}

async fn doctor_route() -> Json<serde_json::Value> {
    Json(json!({ "checks": doctor::run_doctor().await }))
}

/// Same-origin GETs carry no `Origin` header (browsers only send it for
/// non-safe methods), so a read-only endpoint accepts its absence — a
/// cross-site read would carry one and be rejected. Mutations keep using
/// the strict check.
fn origin_ok_read(state: &AppState, headers: &HeaderMap) -> bool {
    match headers.get("origin") {
        None => true,
        Some(_) => origin_ok(state, headers),
    }
}

fn origin_ok(state: &AppState, headers: &HeaderMap) -> bool {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    util::valid_origin(origin, state.port.load(Ordering::SeqCst))
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if !origin_ok(&state, &headers) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "Origin is not allowed" })))
            .into_response();
    }
    let raw = body.map(|Json(value)| value).unwrap_or(json!({}));
    let request: protocol::CreateSessionRequest = match serde_json::from_value(raw) {
        Ok(request) => request,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid session request" })),
            )
                .into_response()
        }
    };
    match state
        .sessions
        .create(
            request.language.unwrap_or(Language::Zig),
            request.scaffold.unwrap_or_default(),
            request.workspace,
        )
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
struct CreateWorkspaceRequest {
    name: Option<String>,
    language: Option<Language>,
    scaffold: Option<protocol::WorkspaceScaffold>,
}

#[derive(serde::Deserialize)]
struct RenameWorkspaceRequest {
    name: String,
}

async fn list_workspaces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !origin_ok_read(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({ "workspaces": workspace::list().await })).into_response()
}

/// Creates the directory and scaffolds it by running one throwaway session
/// against it, so a new workspace is born exactly like a fresh session.
async fn create_workspace(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if !origin_ok(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let raw = body.map(|Json(value)| value).unwrap_or(json!({}));
    let Ok(request) = serde_json::from_value::<CreateWorkspaceRequest>(raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid workspace request" })),
        )
            .into_response();
    };
    let Some(name) = workspace::sanitize_name(request.name.as_deref().unwrap_or("")) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "A workspace needs a name" })),
        )
            .into_response();
    };
    let language = request.language.unwrap_or(Language::Zig);
    let id = util::random_hex(16);
    let dir = workspaces_dir_for(&id);
    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        return internal(error.to_string());
    }
    let now = util::now_ms();
    let meta = workspace::WorkspaceMeta {
        id: id.clone(),
        name,
        language,
        created_at: now,
        updated_at: now,
    };
    if let Err(error) = workspace::write_meta(&dir, &meta).await {
        return internal(error);
    }
    // Scaffolding happens on first attach: create a session, then drop it.
    match state
        .sessions
        .create(
            language,
            request.scaffold.unwrap_or_default(),
            Some(id.clone()),
        )
        .await
    {
        Ok(created) => {
            state.sessions.destroy(&created.session_id).await;
            Json(json!({ "workspace": meta })).into_response()
        }
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            internal(error)
        }
    }
}

async fn rename_workspace(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RenameWorkspaceRequest>,
) -> Response {
    if !origin_ok(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match workspace::rename(&id, &request.name).await {
        Ok(meta) => Json(json!({ "workspace": meta })).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

async fn delete_workspace(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !origin_ok(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match workspace::delete(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct PreferencesRequest {
    preferences: preferences::PreferencesPatch,
}

/// Settings shared by every device that opens this server, so the same
/// Atomis on a laptop and on a tablet agrees with itself.
async fn get_preferences(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !origin_ok_read(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({ "preferences": preferences::read().await })).into_response()
}

/// A patch, not a replacement: a device sends only the keys it changed, so
/// two devices editing different settings never clobber each other.
async fn put_preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if !origin_ok(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let raw = body.map(|Json(value)| value).unwrap_or(json!({}));
    let Ok(request) = serde_json::from_value::<PreferencesRequest>(raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid preferences request" })),
        )
            .into_response();
    };
    match preferences::merge(request.preferences).await {
        Ok(stored) => Json(json!({ "preferences": stored })).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

fn workspaces_dir_for(id: &str) -> std::path::PathBuf {
    workspace::workspaces_root().join(id)
}

fn internal(error: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": error })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct WsQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    lang: Option<String>,
}

async fn ws_runtime_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_ok(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(session) = state
        .sessions
        .authenticate(&query.session_id, &query.token)
        .await
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    upgrade.on_upgrade(move |socket| ws_runtime::handle_runtime(state, session, socket))
}

async fn ws_lsp_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_ok(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(session) = state
        .sessions
        .authenticate(&query.session_id, &query.token)
        .await
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let language = query
        .lang
        .as_deref()
        .and_then(Language::parse)
        .unwrap_or(Language::Zig);
    if !session
        .support
        .get(&language)
        .is_some_and(|support| support.lsp)
    {
        // Mirror the Node close(1011, …): accept the upgrade, close at once.
        return upgrade.on_upgrade(move |mut socket| async move {
            let reason = if language == Language::Rust {
                "rust-analyzer is required"
            } else {
                "ZLS 0.16.x is required"
            };
            let _ = socket
                .send(axum::extract::ws::Message::Close(Some(
                    axum::extract::ws::CloseFrame {
                        code: 1011,
                        reason: reason.into(),
                    },
                )))
                .await;
        });
    }
    upgrade.on_upgrade(move |socket| async move {
        state.lsp_registry.attach(session, language, socket).await;
    })
}

/// Resolves when the process that spawned us is gone.
///
/// The desktop shell pipes our stdin and never writes to it, so the read
/// only ever completes at EOF — which happens when the shell's end of the
/// pipe is closed, including when it is killed outright and its own exit
/// handler never runs. Without this, an orphaned server keeps the port,
/// and the next launch has to pick a different one; since the page origin
/// includes the port, that silently empties every stored preference.
///
/// Opt-in: run from a terminal or with stdin at /dev/null, EOF means
/// nothing, so this only arms when the shell asks for it.
async fn parent_gone() {
    if std::env::var_os("ATOMIS_EXIT_ON_STDIN_EOF").is_none() {
        std::future::pending::<()>().await;
    }
    let mut stdin = tokio::io::stdin();
    let mut discard = [0_u8; 256];
    loop {
        match tokio::io::AsyncReadExt::read(&mut stdin, &mut discard).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

#[tokio::main]
async fn main() {
    // `atomis-server --doctor` replaces the old `tsx apps/server/doctor.ts`.
    if std::env::args().any(|argument| argument == "--doctor") {
        let checks = doctor::run_doctor().await;
        println!("Atomis doctor\n");
        let mut failed = false;
        for check in &checks {
            println!("{} {}", if check.ok { "✓" } else { "✗" }, check.name);
            println!("  detected: {}", check.detected);
            println!("  expected: {}", check.expected);
            println!("  command:  {}", check.command);
            if !check.ok {
                failed = true;
                if let Some(help) = &check.help {
                    println!("  fix:      {help}");
                }
            }
        }
        println!("\nRe-run with: pnpm run doctor");
        std::process::exit(i32::from(failed));
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("ATOMIS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4317);

    let state = Arc::new(AppState::new());
    if let Err(error) = state.sessions.initialize().await {
        tracing::warn!(%error, "session root initialization failed");
    }

    let mut app = Router::new()
        .route("/api/health", get(health))
        .route("/api/doctor", get(doctor_route))
        .route("/api/sessions", post(create_session))
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route(
            "/api/workspaces/{id}",
            axum::routing::patch(rename_workspace).delete(delete_workspace),
        )
        .route(
            "/api/preferences",
            get(get_preferences).put(put_preferences),
        )
        .route("/ws/runtime", get(ws_runtime_route))
        .route("/ws/lsp", get(ws_lsp_route));

    let production = std::env::var("NODE_ENV").is_ok_and(|v| v == "production");
    let web_dist = std::env::var("ATOMIS_WEB_DIST")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| packs::project_root().join("apps/web/dist"));
    if production && web_dist.exists() {
        let serve = tower_http::services::ServeDir::new(&web_dist)
            .fallback(tower_http::services::ServeFile::new(web_dist.join("index.html")));
        app = app.fallback_service(serve);
    }

    let app = app.with_state(Arc::clone(&state));
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind 127.0.0.1");
    let bound = listener.local_addr().expect("local addr");
    state.port.store(bound.port(), Ordering::SeqCst);
    // Same announce line the Tauri shell parses from the Node sidecar.
    println!("ATOMIS_LISTENING={}", bound.port());
    tracing::info!(%bound, "atomis-server (rust) ready — code runs locally with your permissions");

    let shutdown_state = Arc::clone(&state);
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let ctrl_c = tokio::signal::ctrl_c();
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("sigterm handler");
            tokio::select! {
                _ = ctrl_c => {}
                _ = sigterm.recv() => {}
                _ = parent_gone() => {}
            }
            shutdown_state.sessions.close().await;
            // Draining waits for every live connection to finish, and a
            // WebSocket whose peer is gone can hold one open indefinitely —
            // which leaves the port taken and the next launch on a new
            // origin, with no stored preferences. Give the drain a moment
            // to be polite, then leave regardless.
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                std::process::exit(0);
            });
        })
        .await
        .expect("serve");
}
