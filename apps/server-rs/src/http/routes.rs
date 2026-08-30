//! The HTTP surface: sessions, workspaces, preferences and the readiness
//! endpoints. Every handler is guarded before it touches anything.

use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;

use crate::protocol::{self, Language};
use crate::state::AppState;
use crate::util;

use super::guards::{allowed, allowed_read, origin_ok, token_ok};

/// Deliberately unguarded and deliberately empty of detail: a container
/// healthcheck must reach it before anyone holds a token, so it may say only
/// that the process is up.
pub(crate) async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

/// The doctor names the toolchains, their versions and whether the sandbox is
/// enforcing — an inventory of what an intruder would be running against, so
/// it is behind the same guard as the rest.
pub(crate) async fn doctor_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !allowed_read(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({ "checks": crate::languages::doctor::run_doctor().await })).into_response()
}

pub(crate) async fn create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if !allowed(&state, &headers) {
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
pub(crate) struct CreateWorkspaceRequest {
    name: Option<String>,
    language: Option<Language>,
    scaffold: Option<protocol::WorkspaceScaffold>,
}

#[derive(serde::Deserialize)]
pub(crate) struct RenameWorkspaceRequest {
    name: String,
}

pub(crate) async fn list_workspaces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !allowed_read(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({ "workspaces": crate::domain::workspace::list().await })).into_response()
}

/// Creates the directory and scaffolds it by running one throwaway session
/// against it, so a new workspace is born exactly like a fresh session.
pub(crate) async fn create_workspace(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if !allowed(&state, &headers) {
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
    let Some(name) = crate::domain::workspace::sanitize_name(request.name.as_deref().unwrap_or("")) else {
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
    let meta = crate::domain::workspace::WorkspaceMeta {
        id: id.clone(),
        name,
        language,
        created_at: now,
        updated_at: now,
    };
    if let Err(error) = crate::domain::workspace::write_meta(&dir, &meta).await {
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

pub(crate) async fn rename_workspace(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RenameWorkspaceRequest>,
) -> Response {
    if !allowed(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match crate::domain::workspace::rename(&id, &request.name).await {
        Ok(meta) => Json(json!({ "workspace": meta })).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

pub(crate) async fn delete_workspace(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !allowed(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match crate::domain::workspace::delete(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct PreferencesRequest {
    preferences: crate::domain::preferences::PreferencesPatch,
}

/// Settings shared by every device that opens this server, so the same
/// Atomis on a laptop and on a tablet agrees with itself.
pub(crate) async fn get_preferences(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !allowed_read(&state, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({ "preferences": crate::domain::preferences::read().await })).into_response()
}

/// A patch, not a replacement: a device sends only the keys it changed, so
/// two devices editing different settings never clobber each other.
pub(crate) async fn put_preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if !allowed(&state, &headers) {
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
    let patch = request.preferences.clone();
    match crate::domain::preferences::merge(request.preferences).await {
        Ok(stored) => {
            // Only after the write succeeded, and only the keys that moved.
            // Errs when no tab is listening, which is not a failure.
            let _ = state.preference_changes.send(patch);
            Json(json!({ "preferences": stored })).into_response()
        }
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

fn workspaces_dir_for(id: &str) -> std::path::PathBuf {
    crate::domain::workspace::workspaces_root().join(id)
}

fn internal(error: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": error })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
pub(crate) struct WsQuery {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(default)]
    token: String,
    /// The server-wide access token, when one is configured.
    #[serde(rename = "t")]
    access: Option<String>,
    #[serde(default)]
    lang: Option<String>,
}

pub(crate) async fn ws_runtime_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_ok(&state, &headers) || !token_ok(&state, &headers, query.access.as_deref())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(session) = state
        .sessions
        .authenticate(&query.session_id, &query.token)
        .await
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    upgrade.on_upgrade(move |socket| crate::ws::runtime::handle_runtime(state, session, socket))
}

pub(crate) async fn ws_lsp_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_ok(&state, &headers) || !token_ok(&state, &headers, query.access.as_deref())
    {
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
