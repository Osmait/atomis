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

use serde::{Deserialize, Serialize};

use crate::protocol::Language;
use crate::util::now_ms;

const META_FILE: &str = "atomis.json";
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    pub id: String,
    pub name: String,
    pub language: Language,
    pub created_at: u64,
    pub updated_at: u64,
}

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
    tokio::fs::write(dir.join(META_FILE), raw)
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
    if let Some(mut meta) = read_meta(&dir).await {
        meta.updated_at = now_ms();
        let _ = write_meta(&dir, &meta).await;
    }
}

pub async fn rename(id: &str, name: &str) -> Result<WorkspaceMeta, String> {
    let dir = workspace_dir(id).ok_or("Invalid workspace id")?;
    let name = sanitize_name(name).ok_or("A workspace needs a name")?;
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
pub async fn read_sources(source_root: &Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
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
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            let Ok(relative) = path.strip_prefix(source_root) else {
                continue;
            };
            let Some(relative) = relative.to_str() else {
                continue;
            };
            if let Ok(source) = tokio::fs::read_to_string(&path).await {
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
}
