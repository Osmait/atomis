//! Small shared helpers: origin guard, file URLs, ids, constant-time compare.

use std::path::Path;

use rand::RngCore;

/// Mirrors apps/server/src/security/origin.ts: only the server's own origin,
/// plus the Vite dev origin outside production, plus an optional extra dev
/// origin for parallel harnesses (ATOMIS_DEV_ORIGIN).
pub fn valid_origin(origin: Option<&str>, server_port: u16) -> bool {
    let Some(origin) = origin else { return false };
    if origin == format!("http://127.0.0.1:{server_port}") {
        return true;
    }
    let production = std::env::var("NODE_ENV").is_ok_and(|v| v == "production");
    if !production && origin == "http://127.0.0.1:5173" {
        return true;
    }
    if let Ok(extra) = std::env::var("ATOMIS_DEV_ORIGIN") {
        if !production && extra.split(',').any(|o| o.trim() == origin) {
            return true;
        }
    }
    false
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
    fn timing_safe_eq_compares_full_strings() {
        assert!(timing_safe_eq("abc", "abc"));
        assert!(!timing_safe_eq("abc", "abd"));
        assert!(!timing_safe_eq("abc", "abcd"));
    }
}
