//! Who is allowed to call the API.
//!
//! Two independent checks. The Origin guard says a request came from the
//! page; it cannot say who is behind the page, because the Origin it expects
//! is this machine's own name rather than a secret. The token, when one is
//! configured, is the part that can.

use std::sync::atomic::Ordering;

use axum::http::HeaderMap;

use crate::state::AppState;
use crate::util;

/// Same-origin GETs carry no `Origin` header (browsers only send it for
/// non-safe methods), so a read-only endpoint accepts its absence — a
/// cross-site read would carry one and be rejected. Mutations keep using
/// the strict check.
pub(crate) fn origin_ok_read(state: &AppState, headers: &HeaderMap) -> bool {
    match headers.get("origin") {
        None => true,
        Some(_) => origin_ok(state, headers),
    }
}

pub(crate) fn origin_ok(state: &AppState, headers: &HeaderMap) -> bool {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    util::valid_origin(origin, state.port.load(Ordering::SeqCst))
}

/// The Origin guard says the request came from the page; this says it came
/// from someone holding the secret. Both must pass, and when no token is
/// configured this one is a no-op.
pub(crate) fn token_ok(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    util::token_ok(
        state.access_token.as_deref(),
        headers.get("authorization").and_then(|v| v.to_str().ok()),
        query_token,
    )
}

pub(crate) fn allowed(state: &AppState, headers: &HeaderMap) -> bool {
    origin_ok(state, headers) && token_ok(state, headers, None)
}

pub(crate) fn allowed_read(state: &AppState, headers: &HeaderMap) -> bool {
    origin_ok_read(state, headers) && token_ok(state, headers, None)
}
