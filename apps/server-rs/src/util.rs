//! Small shared helpers: origin guard, file URLs, ids, constant-time compare.

use std::path::Path;

use rand::RngCore;

/// Origin guard: the server's own loopback origin, plus the Vite dev origin
/// outside production, plus an optional extra dev origin for parallel
/// harnesses (ATOMIS_DEV_ORIGIN), plus the remote origins of a reverse proxy
/// that fronts the loopback listener (ATOMIS_ALLOWED_ORIGINS).
pub fn valid_origin(origin: Option<&str>, server_port: u16) -> bool {
    let production = std::env::var("NODE_ENV").is_ok_and(|v| v == "production");
    let remote = std::env::var("ATOMIS_ALLOWED_ORIGINS").unwrap_or_default();
    let dev = std::env::var("ATOMIS_DEV_ORIGIN").unwrap_or_default();
    valid_origin_with(origin, server_port, production, &remote, &dev)
}

/// The rule itself, with the environment passed in so it stays testable
/// without mutating process-global state from parallel test threads.
fn valid_origin_with(
    origin: Option<&str>,
    server_port: u16,
    production: bool,
    remote_allowlist: &str,
    dev_allowlist: &str,
) -> bool {
    let Some(origin) = origin else { return false };
    if origin == format!("http://127.0.0.1:{server_port}") {
        return true;
    }
    // Remote access (`tailscale serve`, or any local reverse proxy): the page
    // origin is the proxy's name, while the proxy itself reaches this process
    // over loopback, so the listener stays unreachable from the LAN. Honoured
    // in production because that is the only mode that serves the built UI.
    if listed(remote_allowlist, origin) {
        return true;
    }
    if !production && origin == "http://127.0.0.1:5173" {
        return true;
    }
    if !production && listed(dev_allowlist, origin) {
        return true;
    }
    false
}

/// The shared secret every API call must carry, when one is configured.
///
/// Unset — the default, and how a loopback install runs — leaves the Origin
/// guard as the only check, which is what it has always been. Set it and the
/// guard stops being the whole story: the Origin of a request is not a
/// secret (it is the machine's own name), so on a network where something
/// other than your browser can reach the port, only a secret distinguishes
/// them.
pub fn configured_access_token() -> Option<String> {
    std::env::var("ATOMIS_TOKEN")
        .ok()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

/// `Authorization: Bearer <token>`, or the token a WebSocket carried in its
/// query string — a browser cannot set headers on a socket handshake.
pub fn token_ok(
    expected: Option<&str>,
    authorization: Option<&str>,
    query_token: Option<&str>,
) -> bool {
    let Some(expected) = expected else { return true };
    let bearer = authorization.and_then(|value| value.strip_prefix("Bearer "));
    bearer
        .or(query_token)
        .is_some_and(|presented| timing_safe_eq(presented, expected))
}

/// The interface to listen on, loopback unless ATOMIS_HOST says otherwise.
///
/// An unparseable value is refused rather than quietly falling back: the
/// fallback would be a different exposure than the operator asked for.
pub fn configured_host() -> Result<std::net::IpAddr, String> {
    let Some(raw) = std::env::var_os("ATOMIS_HOST") else {
        return Ok(std::net::IpAddr::from([127, 0, 0, 1]));
    };
    let raw = raw.to_string_lossy().trim().to_string();
    raw.parse()
        .map_err(|_| format!("ATOMIS_HOST is not an IP address: {raw}"))
}

/// Whether this server may start on `host`.
///
/// On loopback only this machine can reach it, which is the single-user
/// desktop case Atomis is built for. Anything wider is reachable by other
/// machines, and reaching this server means running code on it — so beyond
/// loopback a token stops being optional. Refusing to start is the point:
/// a warning in a log is read after the fact, if at all.
pub fn check_exposure(host: std::net::IpAddr, token: Option<&str>) -> Result<(), String> {
    if host.is_loopback() || token.is_some() {
        return Ok(());
    }
    Err(format!(
        "Refusing to listen on {host} without ATOMIS_TOKEN.\n\
         Anything that reaches this port can run code on this machine, so a\n\
         non-loopback address needs a secret. Either set one:\n\
         \n    ATOMIS_TOKEN=$(openssl rand -hex 24) ATOMIS_HOST={host} …\n\
         \nor leave the default 127.0.0.1 and put a proxy that authenticates\n\
         in front of it (Tailscale, a reverse proxy with auth)."
    ))
}

/// The gap between "it is listening" and "it works in a browser".
///
/// In production the Origin guard accepts only this process's own loopback
/// URL plus whatever `ATOMIS_ALLOWED_ORIGINS` lists, so a server reached at
/// any other name serves the page and then refuses every write on it. That
/// is a confusing way to discover an env var, so say it at startup.
pub fn origin_advice(host: std::net::IpAddr, allowlist: &str, production: bool) -> Option<String> {
    if host.is_loopback() || !production {
        return None;
    }
    if allowlist.split(',').any(|entry| !entry.trim().is_empty()) {
        return None;
    }
    Some(format!(
        "Warning: listening on {host} with no ATOMIS_ALLOWED_ORIGINS.\n\
         The page will load and every write on it will be refused, because the\n\
         only origin trusted so far is this process's own. List the address\n\
         people actually type, scheme and port included:\n\
         \n    ATOMIS_ALLOWED_ORIGINS=https://atomis.example.com\n"
    ))
}

/// Comma-separated allowlist membership. Blank entries never match, so an
/// empty variable or a stray comma cannot admit an empty `Origin` header.
fn listed(allowlist: &str, origin: &str) -> bool {
    allowlist
        .split(',')
        .map(str::trim)
        .any(|allowed| !allowed.is_empty() && allowed == origin)
}

/// Node's pathToFileURL for absolute POSIX paths: percent-encodes the WHATWG
/// path set so URIs match the Node server byte for byte on real inputs.
pub fn path_to_file_url(path: &Path) -> String {
    let mut out = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'/'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'!'
            | b'$'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b';'
            | b'='
            | b':'
            | b'@' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn random_base64url(bytes: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    let mut out = String::new();
    for chunk in buffer.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

/// RFC 4122 v4 UUID string from random bytes (run ids).
pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

pub fn timing_safe_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |acc, (l, r)| acc | (l ^ r))
        == 0
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Approximates Node's `localeCompare` (ICU root collation) for project file
/// names: punctuation (` _ - . /`) before digits before letters, lowercase
/// before uppercase at the tertiary level, shorter prefixes first.
pub fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    fn primary(c: char) -> (u8, u32) {
        match c {
            ' ' => (0, 0),
            '_' => (0, 1),
            '-' => (0, 2),
            '.' => (0, 3),
            '/' => (0, 4),
            '0'..='9' => (1, c as u32),
            'a'..='z' => (2, c as u32 - 'a' as u32),
            'A'..='Z' => (2, c as u32 - 'A' as u32),
            _ => (3, c as u32),
        }
    }
    fn tertiary(c: char) -> u8 {
        u8::from(c.is_ascii_uppercase())
    }
    let by_primary = left
        .chars()
        .map(primary)
        .cmp(right.chars().map(primary));
    if by_primary != std::cmp::Ordering::Equal {
        return by_primary;
    }
    left.chars()
        .map(tertiary)
        .cmp(right.chars().map(tertiary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_compare_matches_node_icu_order() {
        let mut files = vec![
            "main.zig", "main_test.py", "utils/helper.zig", "main.c", "a_b.txt",
            "input.txt", "main_test.c", "aoc/day1.zig", "main.test.ts", "A.txt",
            "a.txt", "main.ts",
        ];
        files.sort_by(|l, r| locale_compare(l, r));
        assert_eq!(
            files,
            vec![
                "a_b.txt", "a.txt", "A.txt", "aoc/day1.zig", "input.txt",
                "main_test.c", "main_test.py", "main.c", "main.test.ts",
                "main.ts", "main.zig", "utils/helper.zig",
            ]
        );
    }

    #[test]
    fn file_urls_encode_the_whatwg_path_set() {
        let url = path_to_file_url(std::path::Path::new("/tmp/atomis/a b/main.zig"));
        assert_eq!(url, "file:///tmp/atomis/a%20b/main.zig");
    }

    #[test]
    fn only_the_server_origin_passes_in_production() {
        assert!(valid_origin_with(Some("http://127.0.0.1:4317"), 4317, true, "", ""));
        assert!(!valid_origin_with(Some("http://127.0.0.1:4318"), 4317, true, "", ""));
        assert!(!valid_origin_with(Some("http://127.0.0.1:5173"), 4317, true, "", ""));
        assert!(!valid_origin_with(Some("http://evil.example"), 4317, true, "", ""));
        assert!(!valid_origin_with(None, 4317, true, "", ""));
    }

    #[test]
    fn dev_origins_are_refused_once_production_is_set() {
        let dev = "http://127.0.0.1:5199";
        assert!(valid_origin_with(Some(dev), 4317, false, "", dev));
        assert!(valid_origin_with(Some("http://127.0.0.1:5173"), 4317, false, "", ""));
        assert!(!valid_origin_with(Some(dev), 4317, true, "", dev));
    }

    #[test]
    fn remote_origins_hold_in_production_and_accept_a_list() {
        let list = "https://cachyos.tailnet.ts.net, http://cachyos.tailnet.ts.net";
        assert!(valid_origin_with(
            Some("https://cachyos.tailnet.ts.net"),
            4317,
            true,
            list,
            "",
        ));
        assert!(valid_origin_with(
            Some("http://cachyos.tailnet.ts.net"),
            4317,
            true,
            list,
            "",
        ));
        // Neighbouring names on the same tailnet are not the allowed one.
        assert!(!valid_origin_with(
            Some("https://other.tailnet.ts.net"),
            4317,
            true,
            list,
            "",
        ));
    }

    #[test]
    fn a_blank_allowlist_entry_never_admits_a_blank_origin() {
        assert!(!valid_origin_with(Some(""), 4317, true, "", ""));
        assert!(!valid_origin_with(Some(""), 4317, true, "https://a.ts.net,", ""));
        assert!(!valid_origin_with(Some("   "), 4317, true, " , ", ""));
        assert!(!valid_origin_with(Some("null"), 4317, true, "", ""));
    }

    #[test]
    fn without_a_configured_token_everything_passes() {
        assert!(token_ok(None, None, None));
        assert!(token_ok(None, Some("Bearer whatever"), None));
    }

    #[test]
    fn a_configured_token_is_required_and_compared_whole() {
        let expected = Some("s3cret");
        assert!(token_ok(expected, Some("Bearer s3cret"), None));
        // A socket handshake cannot set headers, so the query carries it.
        assert!(token_ok(expected, None, Some("s3cret")));
        assert!(!token_ok(expected, None, None));
        assert!(!token_ok(expected, Some("Bearer s3cre"), None));
        assert!(!token_ok(expected, Some("Bearer s3crett"), None));
        // The scheme is part of the contract; a bare value is not accepted.
        assert!(!token_ok(expected, Some("s3cret"), None));
        assert!(!token_ok(expected, None, Some("wrong")));
    }

    #[test]
    fn loopback_needs_no_token_and_anything_wider_does() {
        let loopback = std::net::IpAddr::from([127, 0, 0, 1]);
        let all = std::net::IpAddr::from([0, 0, 0, 0]);
        let lan = std::net::IpAddr::from([192, 168, 1, 10]);
        assert!(check_exposure(loopback, None).is_ok());
        assert!(check_exposure(loopback, Some("s")).is_ok());
        // Reaching this server means running code on it.
        assert!(check_exposure(all, None).is_err());
        assert!(check_exposure(lan, None).is_err());
        assert!(check_exposure(all, Some("s")).is_ok());
        assert!(check_exposure(lan, Some("s")).is_ok());
    }

    #[test]
    fn the_refusal_says_what_to_do_about_it() {
        let message = check_exposure(std::net::IpAddr::from([0, 0, 0, 0]), None)
            .expect_err("must refuse");
        assert!(message.contains("ATOMIS_TOKEN"), "names the variable");
        assert!(message.contains("127.0.0.1"), "offers the safe default");
    }

    #[test]
    fn ipv6_loopback_counts_as_loopback() {
        let localhost6: std::net::IpAddr = "::1".parse().expect("valid");
        assert!(check_exposure(localhost6, None).is_ok());
    }

    #[test]
    fn timing_safe_eq_compares_full_strings() {
        assert!(timing_safe_eq("abc", "abc"));
        assert!(!timing_safe_eq("abc", "abd"));
        assert!(!timing_safe_eq("abc", "abcd"));
    }

    #[test]
    fn origin_advice_warns_only_when_it_would_bite() {
        let public = std::net::IpAddr::from([0, 0, 0, 0]);
        let local = std::net::IpAddr::from([127, 0, 0, 1]);
        assert!(origin_advice(public, "", true).is_some());
        // Loopback is reached at the origin the guard already trusts.
        assert!(origin_advice(local, "", true).is_none());
        // Development trusts the Vite origin, so the page works regardless.
        assert!(origin_advice(public, "", false).is_none());
        assert!(origin_advice(public, "https://atomis.example.com", true).is_none());
        // A variable holding nothing but separators is still empty.
        assert!(origin_advice(public, " , ", true).is_some());
    }
}
