//! Atomis backend (Rust rewrite): axum server with the same HTTP + WS
//! contract as apps/server. The Node sidecar stays the reference
//! implementation until the Playwright e2e suite passes against this binary.

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

mod domain;
mod http;
mod exec;
mod languages;
mod protocol;
mod state;
mod util;
mod ws;

use http::routes::{
    create_session, create_workspace, delete_workspace, doctor_route,
    get_preferences, health, list_workspaces, put_preferences, rename_workspace,
    ws_lsp_route, ws_runtime_route,
};
use state::AppState;

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
        let checks = languages::doctor::run_doctor().await;
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

    // The startup sweep only helps a server that restarts. One that stays up
    // for weeks needs the same broom on a timer, or leaked session directories
    // — one build cache each — are what eventually fills its disk.
    {
        let sessions = Arc::clone(&state);
        tokio::spawn(async move {
            let mut hourly = tokio::time::interval(std::time::Duration::from_secs(3600));
            hourly.tick().await; // the immediate first tick; initialize just swept
            loop {
                hourly.tick().await;
                let removed = domain::session::sweep_stale(
                    sessions.sessions.root(),
                    domain::session::STALE_AFTER_MS,
                )
                .await;
                if removed > 0 {
                    tracing::info!(removed, "swept stale session directories");
                }
            }
        });
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
        .unwrap_or_else(|_| languages::packs::project_root().join("apps/web/dist"));
    if production && web_dist.exists() {
        // The UI is 3.8MB of JavaScript, and uncompressed that is what
        // crosses the network on every first visit — on a tablet over a
        // tailnet, the whole wait. `pnpm build` writes a .br and .gz beside
        // each asset; serving those costs nothing at request time, where
        // compressing live cost a brotli encoder per response in flight
        // (86MB resident for twelve concurrent downloads, against 7MB idle).
        let serve = tower_http::services::ServeDir::new(&web_dist)
            .precompressed_br()
            .precompressed_gzip()
            .fallback(
                tower_http::services::ServeFile::new(web_dist.join("index.html"))
                    .precompressed_br()
                    .precompressed_gzip(),
            );
        app = app.fallback_service(serve);
    }

    let app = app.with_state(Arc::clone(&state));
    let host = match util::configured_host() {
        Ok(host) => host,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    // Checked before binding, so an exposed port never exists at all.
    if let Err(message) = util::check_exposure(host, state.access_token.as_deref()) {
        eprintln!("{message}");
        std::process::exit(2);
    }
    if let Some(advice) = util::origin_advice(
        host,
        &std::env::var("ATOMIS_ALLOWED_ORIGINS").unwrap_or_default(),
        production,
    ) {
        eprintln!("{advice}");
    }
    let address = SocketAddr::from((host, port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .unwrap_or_else(|error| panic!("bind {address}: {error}"));
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
