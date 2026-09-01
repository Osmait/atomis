//! Persistent workspaces: named project directories that survive
//! disconnects, restarts and reboots, so files (and later, downloaded
//! dependencies) stay put.
//!
//! Ephemeral sessions keep living under the OS temp dir and are still
//! reaped; a persistent workspace instead lives under the XDG data home and
//! is only ever removed when the user asks. Each carries an `atomis.json`
//! next to its `src/`, so the directory is self-describing: no central
//! index to corrupt or keep in sync.

use std::path::{Path, PathBuf};

use tokio::sync::Mutex;

pub use crate::protocol::WorkspaceMeta;
use crate::util::now_ms;

const META_FILE: &str = "atomis.json";
const MAX_NAME_CHARS: usize = 64;

/// Serializes every meta read-modify-write. `touch` and `rename` both do
/// read → modify → write; interleaved, the slower one resurrects what the
/// faster one just wrote (a rename undone by a timestamp update).
static META_LOCK: Mutex<()> = Mutex::const_new(());

/// `$XDG_DATA_HOME/atomis`, falling back to `~/.local/share/atomis`:
/// everything Atomis keeps between runs lives under here.
pub fn data_root() -> PathBuf {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local/share"))
        })
        .unwrap_or_else(std::env::temp_dir);
    data_home.join("atomis")
}

/// `$XDG_DATA_HOME/atomis/workspaces`, falling back to `~/.local/share`.
/// Overridable with ATOMIS_WORKSPACES for tests and packaged builds.
pub fn workspaces_root() -> PathBuf {
    if let Some(explicit) = std::env::var_os("ATOMIS_WORKSPACES") {
        return PathBuf::from(explicit);
    }
    data_root().join("workspaces")
}

/// Ids are generated, never user input; validating them keeps a crafted id
/// from walking out of the workspaces root.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Trims and bounds a display name. Control characters are dropped so a
/// name can never smuggle escape sequences into a terminal or the UI.
pub fn sanitize_name(raw: &str) -> Option<String> {
    let name: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    (!name.is_empty()).then_some(name)
}

pub fn workspace_dir(id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| workspaces_root().join(id))
}

pub async fn read_meta(dir: &Path) -> Option<WorkspaceMeta> {
    let raw = tokio::fs::read_to_string(dir.join(META_FILE)).await.ok()?;
    serde_json::from_str(&raw).ok()
}

pub async fn write_meta(dir: &Path, meta: &WorkspaceMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    // Write then rename, like preferences: a concurrent `list()` reads the
    // previous meta whole, never half of the new one (half parses as no
    // meta at all, and the workspace vanishes from the picker).
    let temporary = dir.join(format!("{META_FILE}.tmp"));
    tokio::fs::write(&temporary, raw)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&temporary, dir.join(META_FILE))
        .await
        .map_err(|e| e.to_string())
}

/// Every workspace on disk, most recently used first.
pub async fn list() -> Vec<WorkspaceMeta> {
    let root = workspaces_root();
    let mut found = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
        return found;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(meta) = read_meta(&path).await {
            found.push(meta);
        }
    }
    found.sort_by_key(|meta| std::cmp::Reverse(meta.updated_at));
    found
}

pub async fn touch(id: &str) {
    let Some(dir) = workspace_dir(id) else { return };
    let _guard = META_LOCK.lock().await;
    if let Some(mut meta) = read_meta(&dir).await {
        meta.updated_at = now_ms();
        let _ = write_meta(&dir, &meta).await;
    }
}

pub async fn rename(id: &str, name: &str) -> Result<WorkspaceMeta, String> {
    let dir = workspace_dir(id).ok_or("Invalid workspace id")?;
    let name = sanitize_name(name).ok_or("A workspace needs a name")?;
    let _guard = META_LOCK.lock().await;
    let mut meta = read_meta(&dir).await.ok_or("Unknown workspace")?;
    meta.name = name;
    meta.updated_at = now_ms();
    write_meta(&dir, &meta).await?;
    Ok(meta)
}

pub async fn delete(id: &str) -> Result<(), String> {
    let dir = workspace_dir(id).ok_or("Invalid workspace id")?;
    if read_meta(&dir).await.is_none() {
        return Err("Unknown workspace".to_string());
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|error| error.to_string())
}

/// Visible sources of a workspace, as the session snapshot wants them.
/// Walks `src/` depth first; anything unreadable as UTF-8 is skipped
/// (binary assets are mirrored by the runners, not edited in the browser).
///
/// Symlinks are skipped outright: `src/x → /etc/anything` must not come
/// back as the "content" of a project file, and the store's own limits
/// apply here the same as they do to every later edit — a snapshot too big
/// to ever commit is not worth building.
pub async fn read_sources(source_root: &Path) -> Vec<(String, String)> {
    use crate::protocol::{MAX_PROJECT_BYTES, MAX_PROJECT_FILES};
    let mut found = Vec::new();
    let mut total_bytes = 0usize;
    let mut pending = vec![source_root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if found.len() >= MAX_PROJECT_FILES {
                continue;
            }
            let Ok(relative) = path.strip_prefix(source_root) else {
                continue;
            };
            let Some(relative) = relative.to_str() else {
                continue;
            };
            if let Ok(source) = tokio::fs::read_to_string(&path).await {
                if total_bytes + source.len() > MAX_PROJECT_BYTES {
                    continue;
                }
                total_bytes += source.len();
                found.push((relative.to_string(), source));
            }
        }
    }
    found.sort_by(|left, right| crate::util::locale_compare(&left.0, &right.0));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_must_be_generated_hex() {
        assert!(valid_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_id("0123456789ABCDEF0123456789abcdef"));
        assert!(!valid_id("short"));
        // The reason this check exists at all:
        assert!(!valid_id("../../../etc"));
        assert!(workspace_dir("../../etc").is_none());
    }

    #[test]
    fn names_are_trimmed_bounded_and_control_free() {
        assert_eq!(sanitize_name("  aoc 2026 "), Some("aoc 2026".to_string()));
        assert_eq!(sanitize_name("a\u{1b}[31mred"), Some("a[31mred".to_string()));
        assert_eq!(sanitize_name("   "), None);
        assert_eq!(sanitize_name(""), None);
        assert_eq!(
            sanitize_name(&"x".repeat(200)).map(|name| name.len()),
            Some(MAX_NAME_CHARS)
        );
    }

    #[test]
    fn the_root_follows_xdg_and_the_override() {
        temp_env_var("ATOMIS_WORKSPACES", Some("/custom/place"), || {
            assert_eq!(workspaces_root(), PathBuf::from("/custom/place"));
        });
        temp_env_var("ATOMIS_WORKSPACES", None, || {
            temp_env_var("XDG_DATA_HOME", Some("/data"), || {
                assert_eq!(workspaces_root(), PathBuf::from("/data/atomis/workspaces"));
            });
        });
    }

    fn temp_env_var(key: &str, value: Option<&str>, body: impl FnOnce()) {
        let previous = std::env::var_os(key);
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        body();
        match previous {
            Some(previous) => std::env::set_var(key, previous),
            None => std::env::remove_var(key),
        }
    }

    #[tokio::test]
    async fn a_reader_racing_a_meta_write_never_sees_half_a_file() {
        let dir = std::env::temp_dir().join(format!("atomis-meta-{}", crate::util::random_hex(8)));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let meta = |name: &str| WorkspaceMeta {
            id: "0123456789abcdef0123456789abcdef".into(),
            name: name.into(),
            language: crate::protocol::Language::Zig,
            created_at: 1,
            updated_at: 1,
        };
        write_meta(&dir, &meta("first")).await.unwrap();
        let writer_dir = dir.clone();
        let writer = tokio::spawn(async move {
            for turn in 0..200u32 {
                let name = "x".repeat(1 + (turn as usize % 40));
                write_meta(&writer_dir, &meta(&name)).await.unwrap();
            }
        });
        for _ in 0..200 {
            // Pre-fix this raced a plain `fs::write` and read torn JSON,
            // which parses as "no such workspace".
            assert!(read_meta(&dir).await.is_some(), "meta must always parse");
        }
        writer.await.unwrap();
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn read_sources_skips_symlinks_and_keeps_the_store_limits() {
        let root = std::env::temp_dir().join(format!("atomis-src-{}", crate::util::random_hex(8)));
        let src = root.join("src");
        tokio::fs::create_dir_all(&src).await.unwrap();
        let secret = root.join("outside.txt");
        tokio::fs::write(&secret, b"not a project file").await.unwrap();
        tokio::fs::write(src.join("main.zig"), b"real").await.unwrap();
        tokio::fs::symlink(&secret, src.join("sneaky.txt")).await.unwrap();

        let sources = read_sources(&src).await;
        assert!(
            !sources.iter().any(|(path, _)| path == "sneaky.txt"),
            "a symlink's target is not workspace content"
        );
        assert!(sources.iter().any(|(path, _)| path == "main.zig"));

        // More files than a project may hold; whichever make the cut, the
        // snapshot never exceeds what the store would later accept.
        for extra in 0..crate::protocol::MAX_PROJECT_FILES + 5 {
            tokio::fs::write(src.join(format!("extra{extra:03}.txt")), b"x")
                .await
                .unwrap();
        }
        let sources = read_sources(&src).await;
        assert_eq!(sources.len(), crate::protocol::MAX_PROJECT_FILES);
        tokio::fs::remove_dir_all(&root).await.unwrap();
    }
}
