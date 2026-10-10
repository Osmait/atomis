//! The session's HTTP proxy: how the page reaches a program run as a server.
//!
//! The program listens on its session's port on loopback (it gets PORT and
//! HOST, and the sandbox lets it bind there and nowhere else). The browser
//! cannot reach that port — on a host like Railway only the Atomis port is
//! public — so `/api/sessions/{id}/http/<path>` forwards the request there:
//! method, path, query, headers and body, and the response straight back.
//!
//! Atomis's own credentials travel in headers of its own, so the program's
//! `Authorization` (a JWT, Basic auth — the things one practises) reaches it
//! untouched: `x-atomis-token` carries the server-wide token, and
//! `x-atomis-session` the session's.

use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use serde_json::json;

use crate::http::guards::{origin_ok, origin_ok_read};
use crate::state::AppState;

/// A request the program has not answered by then is answered for it.
const PROXY_TIMEOUT: Duration = Duration::from_secs(30);

/// The largest request body forwarded.
pub const MAX_PROXY_BODY_BYTES: usize = 8 * 1024 * 1024;

static CLIENT: LazyLock<Client<HttpConnector, Body>> = LazyLock::new(|| {
    Client::builder(hyper_util::rt::TokioExecutor::new()).build(HttpConnector::new())
});

/// Headers about this hop, not the message: never forwarded either way.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn forwardable(name: &HeaderName) -> bool {
    let name = name.as_str();
    !HOP_BY_HOP.contains(&name) && name != "host" && !name.starts_with("x-atomis-")
}

/// `/api/sessions/{id}/http`: the program's root.
pub(crate) async fn http_proxy_root(
    state: State<Arc<AppState>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    forward(state, id, String::new(), request).await
}

/// `/api/sessions/{id}/http/{*path}`.
pub(crate) async fn http_proxy(
    state: State<Arc<AppState>>,
    Path((id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    forward(state, id, path, request).await
}

/// Atomis's own answer, marked so the page can tell it from the
/// program's: a 502 here means nothing listened, not a 502 the program sent.
fn refuse(status: StatusCode, error: &str) -> Response {
    (
        status,
        [(HeaderName::from_static("x-atomis-proxy-error"), HeaderValue::from_static("1"))],
        Json(json!({ "error": error })),
    )
        .into_response()
}

async fn forward(State(state): State<Arc<AppState>>, id: String, path: String, request: Request) -> Response {
    let headers = request.headers();
    let safe = matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let origin = if safe { origin_ok_read(&state, headers) } else { origin_ok(&state, headers) };
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let bearer = header("x-atomis-token").map(|token| format!("Bearer {token}"));
    if !origin || !crate::util::token_ok(state.access_token.as_deref(), bearer.as_deref(), None) {
        return refuse(StatusCode::FORBIDDEN, "Not allowed");
    }
    let Some(session) = state
        .sessions
        .authenticate(&id, header("x-atomis-session").unwrap_or_default())
        .await
    else {
        return refuse(StatusCode::NOT_FOUND, "Unknown session");
    };
    session.last_http_ms.store(crate::util::now_ms(), Ordering::Relaxed);

    let port = session.http_port;
    let query = request.uri().query().map(|query| format!("?{query}")).unwrap_or_default();
    let Ok(target) = format!("http://127.0.0.1:{port}/{path}{query}").parse::<Uri>() else {
        return refuse(StatusCode::BAD_REQUEST, "Invalid path");
    };
    let (parts, body) = request.into_parts();
    let mut upstream = axum::http::Request::builder().method(parts.method).uri(target);
    for (name, value) in &parts.headers {
        if forwardable(name) {
            upstream = upstream.header(name, value);
        }
    }
    let upstream = match upstream
        .header(header::HOST, format!("127.0.0.1:{port}"))
        .body(body)
    {
        Ok(upstream) => upstream,
        Err(_) => return refuse(StatusCode::BAD_REQUEST, "Invalid request"),
    };

    let response = match tokio::time::timeout(PROXY_TIMEOUT, CLIENT.request(upstream)).await {
        Err(_) => {
            return refuse(
                StatusCode::GATEWAY_TIMEOUT,
                &format!("The program did not answer within {} s", PROXY_TIMEOUT.as_secs()),
            )
        }
        Ok(Err(_)) => {
            return refuse(
                StatusCode::BAD_GATEWAY,
                &format!(
                    "Nothing is listening on port {port}. Turn on \"Run as a server\" and listen on the PORT environment variable ({port})."
                ),
            )
        }
        Ok(Ok(response)) => response,
    };
    let (parts, body) = response.into_parts();
    let mut reply = Response::builder().status(parts.status);
    for (name, value) in &parts.headers {
        if forwardable(name) {
            reply = reply.header(name, value);
        }
    }
    // Opened in a tab, a page the program serves would run on Atomis's own
    // origin, next to its token. `sandbox` gives it an opaque origin of
    // its own instead; scripts and forms still work.
    reply = reply.header(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox allow-scripts allow-forms allow-popups"),
    );
    reply
        .body(Body::new(body))
        .unwrap_or_else(|_| refuse(StatusCode::BAD_GATEWAY, "Invalid response from the program"))
}

/// Whether a header would cross the proxy (exposed for tests).
#[cfg(test)]
fn crosses(name: &str) -> bool {
    forwardable(&HeaderName::from_bytes(name.as_bytes()).expect("header name"))
}

#[cfg(test)]
mod tests {
    use super::crosses;

    #[test]
    fn the_programs_own_headers_cross_and_atomis_ones_do_not() {
        // What one practises with: auth, content negotiation, cookies.
        for name in ["authorization", "content-type", "accept", "cookie", "x-request-id"] {
            assert!(crosses(name), "{name} must reach the program");
        }
        // Atomis's credentials and this hop's own plumbing stay here.
        for name in ["x-atomis-token", "x-atomis-session", "host", "connection", "transfer-encoding"] {
            assert!(!crosses(name), "{name} must not reach the program");
        }
    }
}
