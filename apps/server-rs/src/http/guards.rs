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
/// cross-site read would carry one and be rejected. What stands in for it
/// is `Host`: a page reached through a rebound DNS name is same-origin with
/// us in the browser's eyes, but its requests still say `Host: evil.com`,
/// and that the browser cannot forge. Mutations keep the strict check.
pub(crate) fn origin_ok_read(state: &AppState, headers: &HeaderMap) -> bool {
    if !host_ok(headers) {
        return false;
    }
    match headers.get("origin") {
        None => true,
        Some(_) => origin_ok(state, headers),
    }
}

pub(crate) fn origin_ok(state: &AppState, headers: &HeaderMap) -> bool {
    if !host_ok(headers) {
        return false;
    }
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    util::valid_origin(origin, state.port.load(Ordering::SeqCst))
}

fn host_ok(headers: &HeaderMap) -> bool {
    let host = headers.get("host").and_then(|v| v.to_str().ok());
    util::valid_host(
        host,
        &std::env::var("ATOMIS_ALLOWED_ORIGINS").unwrap_or_default(),
        &std::env::var("ATOMIS_DEV_ORIGIN").unwrap_or_default(),
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn state_on(port: u16) -> AppState {
        let state = AppState::new();
        state.port.store(port, Ordering::SeqCst);
        state
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                HeaderValue::from_str(value).expect("header"),
            );
        }
        map
    }

    #[test]
    fn a_same_origin_get_passes_and_a_mutation_does_not() {
        // Browsers omit Origin on same-origin GETs; reads accept that,
        // writes never do.
        let state = state_on(4317);
        let request = headers(&[("host", "127.0.0.1:4317")]);
        assert!(allowed_read(&state, &request));
        assert!(!allowed(&state, &request));
    }

    #[test]
    fn a_rebound_name_is_refused_even_without_an_origin() {
        // DNS rebinding: the page at evil.com resolves here and fetches
        // without an Origin header. Host is the tell.
        let state = state_on(4317);
        let request = headers(&[("host", "evil.com:4317")]);
        assert!(!allowed_read(&state, &request));
        assert!(!allowed(&state, &request));
        let with_origin = headers(&[
            ("host", "evil.com:4317"),
            ("origin", "http://127.0.0.1:4317"),
        ]);
        assert!(!origin_ok(&state, &with_origin));
    }

    #[test]
    fn the_servers_own_page_passes_everything() {
        let state = state_on(4317);
        for host in ["127.0.0.1:4317", "localhost:4317", "[::1]:4317"] {
            let origin = format!("http://{host}");
            let request = headers(&[("host", host), ("origin", &origin)]);
            assert!(allowed(&state, &request), "{host}");
            assert!(allowed_read(&state, &request), "{host}");
        }
    }

    #[test]
    fn a_foreign_origin_is_refused_with_a_good_host() {
        let state = state_on(4317);
        let request = headers(&[
            ("host", "127.0.0.1:4317"),
            ("origin", "https://evil.example"),
        ]);
        assert!(!allowed(&state, &request));
        assert!(!allowed_read(&state, &request));
    }

    #[test]
    fn a_request_without_a_host_is_refused() {
        // HTTP/1.1 always carries Host; something that does not is not a
        // browser and gets nothing.
        let state = state_on(4317);
        assert!(!allowed_read(&state, &headers(&[])));
    }
}
