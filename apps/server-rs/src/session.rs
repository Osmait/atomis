//! Sessions and the versioned document store, mirrored from
//! apps/server/src/sessions/{SessionManager,DocumentStore}.ts.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::packs::{self, PACKS};
use crate::protocol::{
    CreateSessionResponse, Language, ProbeDescriptor, ProjectFile, MAX_PROJECT_BYTES,
    MAX_PROJECT_FILES,
};
use crate::util::{now_ms, path_to_file_url, random_base64url, random_hex, timing_safe_eq};

#[derive(Debug, Clone)]
pub struct SessionSettings {
    pub auto_run: bool,
    pub auto_inspect: bool,
    pub debounce_ms: u64,
    pub timeout_ms: u64,
    pub manual_probe_ids: Vec<String>,
    /// Confine every process this session spawns to its workspace. On by
    /// default wherever the kernel can enforce it.
    pub sandbox: bool,
}

impl Default for SessionSettings {
    fn default() -> Self {
        SessionSettings {
            auto_run: true,
            auto_inspect: true,
            debounce_ms: 400,
            timeout_ms: 2000,
            sandbox: crate::sandbox::detect_support().available(),
            manual_probe_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LanguageSupport {
    pub present: bool,
    pub run: bool,
    pub lsp: bool,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub version: u64,
    pub uri: String,
    pub source: String,
    pub files: Vec<ProjectFile>,
    pub updated_at: u64,
}

pub struct Session {
    pub id: String,
    pub token: String,
    pub language: Language,
    pub entry_paths: Vec<String>,
    pub root: PathBuf,
    pub source_root: PathBuf,
    pub document_uri: String,
    pub snapshot: Mutex<Snapshot>,
    pub settings: Mutex<SessionSettings>,
    pub probes: Mutex<Vec<ProbeDescriptor>>,
    pub support: HashMap<Language, LanguageSupport>,
    pub runtime_connected: AtomicBool,
    /// Allowlist handed to every child process while the sandbox is on.
    pub sandbox_policy: std::sync::Arc<crate::sandbox::SandboxPolicy>,
    /// Set when the session is attached to a persistent workspace, whose
    /// directory must survive the disconnect that ends the session.
    pub workspace_id: Option<String>,
}

impl Session {
    /// The policy for this session's children, or `None` when the user
    /// turned the sandbox off.
    pub fn sandbox(
        &self,
        settings: &SessionSettings,
    ) -> Option<std::sync::Arc<crate::sandbox::SandboxPolicy>> {
        settings
            .sandbox
            .then(|| std::sync::Arc::clone(&self.sandbox_policy))
    }

    pub async fn current(&self) -> Snapshot {
        self.snapshot.lock().await.clone()
    }

    fn project_file(&self, path: &str, source: String) -> ProjectFile {
        ProjectFile {
            path: path.to_string(),
            uri: path_to_file_url(&self.source_root.join(path)),
            source,
        }
    }

    fn assert_version(snapshot: &Snapshot, version: u64) -> Result<(), String> {
        if version <= snapshot.version {
            Err(format!(
                "Regressive document version {version}; current is {}",
                snapshot.version
            ))
        } else {
            Ok(())
        }
    }

    fn assert_project_size(files: &[ProjectFile]) -> Result<(), String> {
        let bytes: usize = files.iter().map(|f| f.source.len()).sum();
        if bytes > MAX_PROJECT_BYTES {
            Err(format!("Project source exceeds {MAX_PROJECT_BYTES} bytes"))
        } else {
            Ok(())
        }
    }

    fn commit(&self, snapshot: &mut Snapshot, version: u64, mut files: Vec<ProjectFile>) -> Result<Snapshot, String> {
        files.sort_by(|l, r| crate::util::locale_compare(&l.path, &r.path));
        let primary = self.entry_paths.first().cloned().unwrap_or_else(|| "main.zig".into());
        let main = files
            .iter()
            .find(|f| f.path == primary)
            .ok_or_else(|| format!("Project entry point {primary} is missing"))?;
        snapshot.version = version;
        snapshot.uri = main.uri.clone();
        snapshot.source = main.source.clone();
        snapshot.files = files;
        snapshot.updated_at = now_ms();
        Ok(snapshot.clone())
    }

    async fn atomic_write(&self, path: &str, source: &str) -> Result<(), String> {
        let destination = self.source_root.join(path);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        let temporary = destination
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!(".atomis-{}-{}.tmp", std::process::id(), random_hex(8)));
        tokio::fs::write(&temporary, source)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&temporary, &destination)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn update(&self, version: u64, path: &str, source: &str) -> Result<Snapshot, String> {
        let mut snapshot = self.snapshot.lock().await;
        Self::assert_version(&snapshot, version)?;
        if !snapshot.files.iter().any(|f| f.path == path) {
            return Err(format!("File does not exist: {path}"));
        }
        let files: Vec<ProjectFile> = snapshot
            .files
            .iter()
            .map(|f| {
                if f.path == path {
                    self.project_file(path, source.to_string())
                } else {
                    f.clone()
                }
            })
            .collect();
        Self::assert_project_size(&files)?;
        self.atomic_write(path, source).await?;
        self.commit(&mut snapshot, version, files)
    }

    pub async fn create_file(
        &self,
        version: u64,
        path: &str,
        source: &str,
    ) -> Result<Snapshot, String> {
        let mut snapshot = self.snapshot.lock().await;
        Self::assert_version(&snapshot, version)?;
        if snapshot.files.len() >= MAX_PROJECT_FILES {
            return Err(format!(
                "A project can contain at most {MAX_PROJECT_FILES} files"
            ));
        }
        if snapshot.files.iter().any(|f| f.path == path) {
            return Err(format!("File already exists: {path}"));
        }
        let mut files = snapshot.files.clone();
        files.push(self.project_file(path, source.to_string()));
        Self::assert_project_size(&files)?;
        self.atomic_write(path, source).await?;
        self.commit(&mut snapshot, version, files)
    }

    pub async fn rename_file(
        &self,
        version: u64,
        path: &str,
        new_path: &str,
    ) -> Result<Snapshot, String> {
        let mut snapshot = self.snapshot.lock().await;
        Self::assert_version(&snapshot, version)?;
        if self.entry_paths.iter().any(|p| p == path) {
            return Err(format!("{path} cannot be renamed"));
        }
        let Some(current) = snapshot.files.iter().find(|f| f.path == path).cloned() else {
            return Err(format!("File does not exist: {path}"));
        };
        if snapshot.files.iter().any(|f| f.path == new_path) {
            return Err(format!("File already exists: {new_path}"));
        }
        let destination = self.source_root.join(new_path);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::rename(self.source_root.join(path), destination)
            .await
            .map_err(|e| e.to_string())?;
        let files: Vec<ProjectFile> = snapshot
            .files
            .iter()
            .map(|f| {
                if f.path == path {
                    self.project_file(new_path, current.source.clone())
                } else {
                    f.clone()
                }
            })
            .collect();
        self.commit(&mut snapshot, version, files)
    }

    pub async fn delete_file(&self, version: u64, path: &str) -> Result<Snapshot, String> {
        let mut snapshot = self.snapshot.lock().await;
        Self::assert_version(&snapshot, version)?;
        if self.entry_paths.iter().any(|p| p == path) {
            return Err(format!("{path} cannot be deleted"));
        }
        if !snapshot.files.iter().any(|f| f.path == path) {
            return Err(format!("File does not exist: {path}"));
        }
        let _ = tokio::fs::remove_file(self.source_root.join(path)).await;
        let files: Vec<ProjectFile> = snapshot
            .files
            .iter()
            .filter(|f| f.path != path)
            .cloned()
            .collect();
        self.commit(&mut snapshot, version, files)
    }
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub root: PathBuf,
    toolchain: tokio::sync::OnceCell<HashMap<String, String>>,
}

async fn command_version(command: &str, args: &[&str]) -> String {
    let output = tokio::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .trim()
            .lines()
            .next()
            .unwrap_or("")
            .to_string(),
        _ => "unavailable".to_string(),
    }
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            sessions: Mutex::new(HashMap::new()),
            root: std::env::temp_dir().join("atomis"),
            toolchain: tokio::sync::OnceCell::new(),
        }
    }

    pub async fn initialize(&self) -> std::io::Result<()> {
        tokio::fs::create_dir_all(&self.root).await?;
        let cutoff = now_ms().saturating_sub(24 * 60 * 60 * 1000);
        let mut entries = tokio::fs::read_dir(&self.root).await?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(u64::MAX);
            if meta.is_dir() && modified < cutoff {
                let _ = tokio::fs::remove_dir_all(entry.path()).await;
            }
        }
        Ok(())
    }

    async fn detect_toolchain(&self) -> &HashMap<String, String> {
        self.toolchain
            .get_or_init(|| async {
                let mut checks: Vec<(&str, &[&str])> = Vec::new();
                for pack in PACKS.iter() {
                    checks.push((pack.run.command, pack.run.args));
                    if let Some(lsp) = &pack.lsp {
                        checks.push((lsp.command, lsp.args));
                    }
                }
                checks.sort();
                checks.dedup();
                let mut versions = HashMap::new();
                let futures = checks
                    .into_iter()
                    .map(|(command, args)| async move {
                        (command.to_string(), command_version(command, args).await)
                    })
                    .collect::<Vec<_>>();
                for (command, version) in futures::join_all(futures).await {
                    versions.insert(command, version);
                }
                versions
            })
            .await
    }

    pub async fn create(
        &self,
        preferred: Language,
        scaffold: crate::protocol::WorkspaceScaffold,
        workspace: Option<String>,
    ) -> Result<CreateSessionResponse, String> {
        let id = random_hex(16);
        let token = random_base64url(32);
        // A persistent workspace keeps its own directory; an ephemeral
        // session gets a fresh one under the temp root.
        let workspace_meta = match &workspace {
            Some(workspace_id) => {
                let dir = crate::workspace::workspace_dir(workspace_id)
                    .ok_or("Invalid workspace id")?;
                let meta = crate::workspace::read_meta(&dir)
                    .await
                    .ok_or("Unknown workspace")?;
                Some((dir, meta))
            }
            None => None,
        };
        let root = match &workspace_meta {
            Some((dir, _)) => dir.clone(),
            None => self.root.join(&id),
        };
        let source_root = root.join("src");
        for dir in [
            &source_root,
            &root.join("generated"),
            &root.join(".zig-cache"),
            // Sandboxed toolchains write their caches here (see sandbox.rs).
            &root.join(".tmp"),
            &root.join(".cache"),
        ] {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|e| e.to_string())?;
        }

        let versions = self.detect_toolchain().await;
        let mut support = HashMap::new();
        let mut toolchains = Map::new();
        let mut degraded = Map::new();
        for pack in PACKS.iter() {
            let unavailable = "unavailable".to_string();
            let run_version = versions.get(pack.run.command).unwrap_or(&unavailable);
            let lsp_version = pack
                .lsp
                .as_ref()
                .and_then(|l| versions.get(l.command))
                .unwrap_or(&unavailable);
            let run = (pack.run.compatible)(run_version);
            let lsp = run
                && pack
                    .lsp
                    .as_ref()
                    .is_some_and(|l| (l.compatible)(lsp_version));
            support.insert(
                pack.id,
                LanguageSupport {
                    present: pack.scaffold_always || run,
                    run,
                    lsp,
                },
            );
            toolchains.insert(
                pack.id.as_str().to_string(),
                json!({ "run": run_version, "lsp": lsp_version }),
            );
            if !run {
                degraded.insert(
                    pack.id.as_str().to_string(),
                    json!(format!(
                        "Expected {}, detected {run_version}",
                        pack.run.expected
                    )),
                );
            } else if let Some(lsp_check) = &pack.lsp {
                if !lsp {
                    let message = if lsp_version == "unavailable" {
                        format!(
                            "{} not installed · editor completion disabled (optional)",
                            lsp_check.expected
                        )
                    } else {
                        format!("{} no compatible ({lsp_version})", lsp_check.expected)
                    };
                    degraded.insert(format!("{}-lsp", pack.id.as_str()), json!(message));
                }
            }
        }

        // Bilingual-by-extension workspace: scaffold and create the entry file
        // of every supported language; the preferred one becomes the first tab.
        let included: Vec<&'static crate::packs::LanguagePack> = PACKS
            .iter()
            .filter(|p| support.get(&p.id).is_some_and(|s| s.present))
            .collect();
        for pack in &included {
            packs::scaffold(pack.id, &root)
                .await
                .map_err(|e| format!("scaffold {}: {e}", pack.id.as_str()))?;
        }
        let preferred = workspace_meta
            .as_ref()
            .map(|(_, meta)| meta.language)
            .unwrap_or(preferred);
        let language = if included.iter().any(|p| p.id == preferred) {
            preferred
        } else {
            Language::Zig
        };
        // Visible src/ files: the demo scaffold carries every language's
        // example; minimal starts with just the chosen language's entry.
        // Language templates outside src/ are staged either way, so files
        // of any supported language can be created and run later.
        let existing = match &workspace_meta {
            Some(_) => crate::workspace::read_sources(&source_root).await,
            None => Vec::new(),
        };
        let mut sources: Vec<(String, String)> = Vec::new();
        let minimal = scaffold == crate::protocol::WorkspaceScaffold::Minimal;
        for pack in &included {
            if minimal && pack.id != language {
                continue;
            }
            if !sources.iter().any(|(p, _)| p == pack.entry_file) {
                sources.push((pack.entry_file.to_string(), pack.default_source.to_string()));
            }
            if minimal {
                continue;
            }
            for (path, content) in pack.extra_files {
                if !sources.iter().any(|(p, _)| p == path) {
                    sources.push((path.to_string(), content.to_string()));
                }
            }
        }
        // Attaching to a workspace that already has sources never rewrites
        // them; only a brand new one gets the scaffold.
        if !existing.is_empty() {
            sources = existing;
        } else {
            for (entry, source) in &sources {
                tokio::fs::write(source_root.join(entry), source)
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::fs::write(root.join("generated").join(entry), source)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        let primary_entry = packs::pack(language).entry_file.to_string();
        let mut entry_paths = vec![primary_entry.clone()];
        for pack in &included {
            if pack.entry_file != primary_entry {
                entry_paths.push(pack.entry_file.to_string());
            }
        }
        let mut initial_files: Vec<ProjectFile> = sources
            .iter()
            .map(|(path, source)| ProjectFile {
                path: path.clone(),
                uri: path_to_file_url(&source_root.join(path)),
                source: source.clone(),
            })
            .collect();
        initial_files.sort_by(|l, r| crate::util::locale_compare(&l.path, &r.path));
        let document_uri = path_to_file_url(&source_root.join(&primary_entry));
        let initial_source = sources
            .iter()
            .find(|(p, _)| *p == primary_entry)
            .map(|(_, s)| s.clone())
            .unwrap_or_else(|| crate::protocol::DEFAULT_ZIG_SOURCE.to_string());

        let sandbox_policy = std::sync::Arc::new(crate::sandbox::policy_for(
            &root,
            &crate::packs::project_root(),
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .as_deref(),
        ));
        let session = Arc::new(Session {
            id: id.clone(),
            token: token.clone(),
            language,
            entry_paths,
            root,
            source_root,
            document_uri: document_uri.clone(),
            snapshot: Mutex::new(Snapshot {
                version: 1,
                uri: document_uri.clone(),
                source: initial_source.clone(),
                files: initial_files.clone(),
                updated_at: now_ms(),
            }),
            settings: Mutex::new(SessionSettings::default()),
            probes: Mutex::new(Vec::new()),
            support,
            runtime_connected: AtomicBool::new(false),
            sandbox_policy,
            workspace_id: workspace.clone(),
        });
        if let Some(workspace_id) = &workspace {
            crate::workspace::touch(workspace_id).await;
        }
        self.sessions.lock().await.insert(id.clone(), session);

        let run_of = |lang: &str| -> String {
            toolchains
                .get(lang)
                .and_then(|v| v.get("run"))
                .and_then(Value::as_str)
                .unwrap_or("unavailable")
                .to_string()
        };
        let lsp_of = |lang: &str| -> String {
            toolchains
                .get(lang)
                .and_then(|v| v.get("lsp"))
                .and_then(Value::as_str)
                .unwrap_or("unavailable")
                .to_string()
        };
        Ok(CreateSessionResponse {
            session_id: id,
            auth_token: token,
            language,
            document_uri,
            zig_version: run_of("zig"),
            zls_version: lsp_of("zig"),
            rustc_version: run_of("rust"),
            cargo_version: run_of("rust"),
            rust_analyzer_version: lsp_of("rust"),
            toolchains,
            initial_source,
            files: initial_files,
            degraded,
            sandbox_support: crate::sandbox::detect_support().as_str().to_string(),
            sandbox: crate::sandbox::detect_support().available(),
            workspace: workspace_meta.map(|(_, meta)| meta),
        })
    }

    pub async fn authenticate(&self, id: &str, token: &str) -> Option<Arc<Session>> {
        if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            return None;
        }
        if token.len() > 128 {
            return None;
        }
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        if timing_safe_eq(&session.token, token) {
            Some(Arc::clone(session))
        } else {
            None
        }
    }

    pub async fn destroy(&self, id: &str) {
        let session = self.sessions.lock().await.remove(id);
        if let Some(session) = session {
            if let Some(workspace_id) = &session.workspace_id {
                // Persistent: the files stay, only the in-memory session goes.
                crate::workspace::touch(workspace_id).await;
                return;
            }
            let _ = tokio::fs::remove_dir_all(&session.root).await;
        }
    }

    pub async fn close(&self) {
        let ids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for id in ids {
            self.destroy(&id).await;
        }
    }
}

mod futures {
    /// Minimal join_all to avoid pulling the futures crate.
    pub async fn join_all<F, T>(futures: Vec<F>) -> Vec<T>
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            if let Ok(value) = handle.await {
                out.push(value);
            }
        }
        out
    }
}
