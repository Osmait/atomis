//! Atomis backend (Rust rewrite): axum server with the same HTTP + WS
//! contract as apps/server. The Node sidecar stays the reference
//! implementation until the Playwright e2e suite passes against this binary.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;

mod doctor;
mod markers;
mod ndjson;
mod packs;
mod protocol;
mod runners;
mod sandbox;
mod scheduler;
mod session;
mod state;
mod supervisor;
mod util;
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
            }
            shutdown_state.sessions.close().await;
        })
        .await
        .expect("serve");
}
