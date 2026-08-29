//! Preferences shared by every device that opens this server.
//!
//! The UI used to keep its settings in `localStorage`, which is per browser:
//! reaching the same Atomis from a laptop and from a tablet gave you two
//! different sets of settings. They live here instead, as one small JSON
//! object beside the workspaces. Layout state stays in the browser — a
//! tablet and a 27" monitor genuinely want different panels open.

use std::collections::BTreeMap;
use std::path::PathBuf;

use tokio::sync::Mutex;

const FILE: &str = "preferences.json";

/// Bounds so a client cannot grow the store without limit. The settings we
/// sync are a handful of short keys holding small JSON blobs, so these are
/// far above anything the UI produces and far below anything that hurts.
const MAX_KEYS: usize = 64;
const MAX_KEY_BYTES: usize = 128;
const MAX_VALUE_BYTES: usize = 16 * 1024;

pub type Preferences = BTreeMap<String, String>;

/// A patch entry of `None` deletes the key.
pub type PreferencesPatch = BTreeMap<String, Option<String>>;

/// Overridable with ATOMIS_PREFERENCES for tests and packaged builds.
pub fn path() -> PathBuf {
    if let Some(explicit) = std::env::var_os("ATOMIS_PREFERENCES") {
        return PathBuf::from(explicit);
    }
    crate::workspace::data_root().join(FILE)
}

/// Serializes read-modify-write, so two devices saving at the same moment
/// cannot drop each other's keys.
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

/// Missing or corrupt reads as empty: a preferences file is a convenience,
/// never a reason to fail a page load. The UI falls back to its defaults.
pub async fn read() -> Preferences {
    read_at(&path()).await
}

/// Merges `patch` key by key and returns what is now stored. Merging rather
/// than replacing is what lets two devices change different settings
/// without either one clobbering the other's.
pub async fn merge(patch: PreferencesPatch) -> Result<Preferences, String> {
    merge_at(&path(), patch).await
}

async fn read_at(path: &std::path::Path) -> Preferences {
    let Ok(raw) = tokio::fs::read_to_string(path).await else {
        return Preferences::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// The rule itself, with the file passed in so tests never have to reach
/// for a process-global env var from parallel threads.
async fn merge_at(path: &std::path::Path, patch: PreferencesPatch) -> Result<Preferences, String> {
    for (key, value) in &patch {
        if key.is_empty() || key.len() > MAX_KEY_BYTES {
            return Err("Invalid preference key".into());
        }
        if value.as_ref().is_some_and(|v| v.len() > MAX_VALUE_BYTES) {
            return Err("Preference value is too large".into());
        }
    }

    let _guard = WRITE_LOCK.lock().await;
    let mut stored = read_at(path).await;
    for (key, value) in patch {
        match value {
            Some(value) => {
                stored.insert(key, value);
            }
            None => {
                stored.remove(&key);
            }
        }
    }
    if stored.len() > MAX_KEYS {
        return Err("Too many preferences".into());
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    // Write then rename: a device loading the page mid-save reads the
    // previous file, never half of the new one.
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, raw)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file of its own per test, so the suite's threads never collide.
    struct TempPrefs(PathBuf);

    impl TempPrefs {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("atomis-prefs-{name}.json"));
            let _ = std::fs::remove_file(&path);
            TempPrefs(path)
        }
    }

    impl Drop for TempPrefs {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn patch(pairs: &[(&str, Option<&str>)]) -> PreferencesPatch {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.map(str::to_string)))
            .collect()
    }

    #[tokio::test]
    async fn a_missing_file_reads_as_empty() {
        let prefs = TempPrefs::new("missing");
        assert!(read_at(&prefs.0).await.is_empty());
    }

    #[tokio::test]
    async fn writes_from_two_devices_merge_instead_of_replacing() {
        let prefs = TempPrefs::new("merge");
        merge_at(&prefs.0, patch(&[("atomis.theme", Some("mocha"))]))
            .await
            .expect("first write");
        // The second device knows nothing about the first device's key.
        let stored = merge_at(&prefs.0, patch(&[("atomis.vim", Some("true"))]))
            .await
            .expect("second write");
        assert_eq!(stored.get("atomis.theme").map(String::as_str), Some("mocha"));
        assert_eq!(stored.get("atomis.vim").map(String::as_str), Some("true"));
    }

    #[tokio::test]
    async fn a_null_value_deletes_the_key() {
        let prefs = TempPrefs::new("delete");
        merge_at(&prefs.0, patch(&[("atomis.theme", Some("crust"))]))
            .await
            .expect("write");
        let stored = merge_at(&prefs.0, patch(&[("atomis.theme", None)]))
            .await
            .expect("delete");
        assert!(stored.is_empty());
    }

    #[tokio::test]
    async fn oversized_keys_and_values_are_refused() {
        let prefs = TempPrefs::new("bounds");
        let long_key = "k".repeat(MAX_KEY_BYTES + 1);
        assert!(merge_at(&prefs.0, patch(&[(long_key.as_str(), Some("x"))]))
            .await
            .is_err());
        let big = "v".repeat(MAX_VALUE_BYTES + 1);
        assert!(merge_at(&prefs.0, patch(&[("atomis.theme", Some(big.as_str()))]))
            .await
            .is_err());
        assert!(merge_at(&prefs.0, patch(&[("", Some("x"))])).await.is_err());
        // Nothing was written by the refused calls.
        assert!(read_at(&prefs.0).await.is_empty());
    }

    #[tokio::test]
    async fn corrupt_json_reads_as_empty_rather_than_failing() {
        let prefs = TempPrefs::new("corrupt");
        std::fs::write(&prefs.0, "{not json").expect("seed");
        assert!(read_at(&prefs.0).await.is_empty());
    }
}
