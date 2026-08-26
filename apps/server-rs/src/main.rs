//! ZigLive backend rewrite (phase 0): axum skeleton with the same contract
//! surface as apps/server. The Node sidecar stays the production backend
//! until this reaches parity, validated by the existing Playwright e2e.

use std::net::SocketAddr;

use axum::{routing::get, Json, Router};
use serde_json::json;

mod protocol;

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "host": "127.0.0.1" }))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("ZIGLIVE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4317);

    let app = Router::new().route("/api/health", get(health));

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind 127.0.0.1");
    let bound = listener.local_addr().expect("local addr");
    // Same announce line the Tauri shell parses from the Node sidecar.
    println!("ZIGLIVE_LISTENING={}", bound.port());
    tracing::info!(%bound, "ziglive-server (rust) ready");

    axum::serve(listener, app).await.expect("serve");
}
