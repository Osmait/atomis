//! Building a Go session with the compiler and linker directly.
//!
//! `go build ./generated` runs `compile` on the package and `link` on the
//! result, and spends ~30 of its ~95 ms around them: loading the module,
//! hashing every dependency to decide what is stale, staging a work
//! directory. For a session the go command has nothing else to do for — no
//! module dependencies, no cgo, one package — those two tools are run
//! here, with the import configuration `go list -export` resolves once and
//! that is reused until the program's imports change.
//!
//! `None` from `build` means "run go build instead": the session does not
//! qualify, a tool could not run, or the configuration went stale (an
//! export file the cache has since trimmed). A compile that ran and found
//! errors is returned like go build's, its messages in the same format.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::exec::sandbox::SandboxPolicy;
use crate::exec::supervisor::{self, ProcessLimits, ProcessResult, RunOptions, StreamCallbacks};

/// Per session root: the import set the stored configuration was built
/// for. The file itself lives in the session's target directory.
static RESOLVED: LazyLock<Mutex<HashMap<PathBuf, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static TOOLCHAIN: tokio::sync::OnceCell<Option<Toolchain>> = tokio::sync::OnceCell::const_new();

/// What the go command tells its tools. It sets the target variables in
/// their environment from `go env`; run alone, a tool falls back to the
/// defaults it was built with, which need not agree — a distribution that
/// builds Go for GOAMD64=v3 makes `compile` expect v3 objects while the
/// build cache holds v1 ones, and every import fails.
#[derive(Clone)]
struct Toolchain {
    dir: PathBuf,
    env: Vec<(String, String)>,
}

/// The variables the go command passes to compile and link.
const TOOL_ENV: [&str; 12] = [
    "GOROOT", "GOOS", "GOARCH", "GOAMD64", "GO386", "GOARM", "GOARM64",
    "GOMIPS", "GOMIPS64", "GOPPC64", "GORISCV64", "GOEXPERIMENT",
];

pub struct Build<'a> {
    pub root: &'a Path,
    pub executable: &'a Path,
    pub env: Vec<(String, String)>,
    pub sandbox: Option<Arc<SandboxPolicy>>,
    pub cancel: &'a CancellationToken,
    pub timeout_ms: u64,
    pub ldflags: &'a [&'a str],
}

/// The module's `go` directive as a `-lang` value, or `None` when go.mod
/// asks for anything the go command must handle (dependencies,
/// replacements, toolchain switches).
fn language_version(go_mod: &str) -> Option<String> {
    let mut version = None;
    for line in go_mod.lines().map(str::trim) {
        let word = line.split_whitespace().next().unwrap_or("");
        match word {
            "module" | "" | "//" => {}
            "go" => version = line.split_whitespace().nth(1).map(|v| format!("go{v}")),
            _ if word.starts_with("//") => {}
            // require, replace, exclude, retract, toolchain, godebug…
            _ => return None,
        }
    }
    version
}

/// Every import of the package, or `None` for cgo (`import "C"`), which
/// only the go command can build.
fn imports(sources: &[String]) -> Option<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    for source in sources {
        let mut in_block = false;
        for line in source.lines().map(str::trim) {
            let spec = if in_block {
                if line.starts_with(')') {
                    in_block = false;
                    continue;
                }
                line
            } else if let Some(rest) = line.strip_prefix("import") {
                let rest = rest.trim();
                if rest.starts_with('(') {
                    in_block = true;
                    rest.trim_start_matches('(').trim()
                } else {
                    rest
                }
            } else {
                continue;
            };
            // `alias "path"`, `_ "path"`, `. "path"` or just `"path"`.
            if let Some(path) = spec.split('"').nth(1) {
                if path == "C" {
                    return None;
                }
                if !path.is_empty() {
                    found.insert(path.to_string());
                }
            }
        }
    }
    Some(found)
}

async fn toolchain() -> Option<Toolchain> {
    TOOLCHAIN
        .get_or_init(|| async {
            let output = tokio::process::Command::new("go")
                .args(["env", "-json", "GOTOOLDIR"])
                .args(TOOL_ENV)
                .output()
                .await
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let values: serde_json::Map<String, serde_json::Value> =
                serde_json::from_slice(&output.stdout).ok()?;
            let dir = values.get("GOTOOLDIR")?.as_str().filter(|dir| !dir.is_empty())?;
            let env = TOOL_ENV
                .iter()
                .filter_map(|name| {
                    let value = values.get(*name)?.as_str()?;
                    (!value.is_empty()).then(|| (name.to_string(), value.to_string()))
                })
                .collect();
            Some(Toolchain { dir: PathBuf::from(dir), env })
        })
        .await
        .clone()
}

async fn run(build: &Build<'_>, program: &str, args: &[String]) -> ProcessResult {
    supervisor::run(
        program,
        args,
        RunOptions {
            cwd: build.root.to_path_buf(),
            limits: ProcessLimits::new(build.timeout_ms, 512 * 1024, 1024 * 1024),
            cancel: build.cancel.clone(),
            probe_fd: false,
            env: build.env.clone(),
            sandbox: build.sandbox.clone(),
            callbacks: StreamCallbacks::default(),
        },
    )
    .await
}

pub async fn build(build: &Build<'_>) -> Option<ProcessResult> {
    let go_mod = tokio::fs::read_to_string(build.root.join("go.mod")).await.ok()?;
    let lang = language_version(&go_mod)?;
    let toolchain = toolchain().await?;
    let tools = toolchain.dir.clone();
    // The go command's own environment for its tools, after the session's.
    let tool_build = Build {
        env: build.env.iter().cloned().chain(toolchain.env.iter().cloned()).collect(),
        sandbox: build.sandbox.clone(),
        ..*build
    };
    let build = &tool_build;
    let mut files: Vec<String> = Vec::new();
    let mut sources: Vec<String> = Vec::new();
    let mut entries = tokio::fs::read_dir(build.root.join("generated")).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".go") && !name.ends_with("_test.go") {
            let source = tokio::fs::read_to_string(entry.path()).await.ok()?;
            // Build constraints choose files; that is the go command's job.
            if source.contains("//go:build") || source.contains("// +build") {
                return None;
            }
            sources.push(source);
            files.push(format!("./generated/{name}"));
        } else if entry.file_type().await.ok()?.is_dir() {
            // A package inside the package: the go command's job.
            return None;
        }
    }
    files.sort();
    let imports = imports(&sources)?;
    let target = build.root.join("target");
    let importcfg = target.join("importcfg");
    let key = imports.iter().cloned().collect::<Vec<_>>().join(" ");

    let mut started_ms = 0.0;
    let cached = RESOLVED.lock().await.get(build.root).is_some_and(|stored| *stored == key) && importcfg.exists();
    if !cached {
        // Every package the program can reach, the runtime included, with
        // the export file the build cache holds for it — compiled now if
        // the cache does not have it yet.
        let mut args: Vec<String> = vec![
            "list".into(),
            "-export".into(),
            "-deps".into(),
            "-f".into(),
            "{{if .Export}}packagefile {{.ImportPath}}={{.Export}}{{end}}".into(),
            "runtime".into(),
        ];
        args.extend(imports.iter().cloned());
        let listed = run(build, "go", &args).await;
        if listed.exit_code != Some(0) {
            return None;
        }
        started_ms += listed.duration_ms;
        tokio::fs::write(&importcfg, listed.stdout.as_bytes()).await.ok()?;
        RESOLVED.lock().await.insert(build.root.to_path_buf(), key.clone());
    }

    let archive = target.join("main.a");
    let mut compile_args: Vec<String> = vec![
        "-o".into(),
        archive.to_string_lossy().into_owned(),
        "-p".into(),
        "main".into(),
        format!("-lang={lang}"),
        "-complete".into(),
        "-nolocalimports".into(),
        "-importcfg".into(),
        importcfg.to_string_lossy().into_owned(),
        "-pack".into(),
    ];
    compile_args.extend(files);
    let mut compile = run(build, &tools.join("compile").to_string_lossy(), &compile_args).await;
    compile.duration_ms += started_ms;
    // The compiler reports on stdout; the go command passes its output on
    // as stderr, which is where the runner reads diagnostics.
    if !compile.stdout.is_empty() {
        compile.stderr = format!("{}{}", std::mem::take(&mut compile.stdout), compile.stderr);
    }
    if compile.cancelled || compile.timed_out {
        return Some(compile);
    }
    if compile.exit_code != Some(0) {
        // An export file the cache trimmed reads like a broken import; the
        // configuration is stale, not the program.
        if compile.stderr.contains("could not import") && cached {
            RESOLVED.lock().await.remove(build.root);
            return None;
        }
        // A compiler that never ran is go build's to try.
        compile.exit_code?;
        return Some(compile);
    }

    let link_cfg = target.join("importcfg.link");
    let mut config = tokio::fs::read_to_string(&importcfg).await.ok()?;
    config.push_str(&format!("packagefile main={}\n", archive.to_string_lossy()));
    tokio::fs::write(&link_cfg, config).await.ok()?;
    let mut link_args: Vec<String> = vec![
        "-o".into(),
        build.executable.to_string_lossy().into_owned(),
        "-importcfg".into(),
        link_cfg.to_string_lossy().into_owned(),
        "-buildmode=exe".into(),
    ];
    link_args.extend(build.ldflags.iter().map(|flag| flag.to_string()));
    link_args.push(archive.to_string_lossy().into_owned());
    let link = run(build, &tools.join("link").to_string_lossy(), &link_args).await;
    if link.cancelled || link.timed_out {
        return Some(link);
    }
    if link.exit_code != Some(0) {
        RESOLVED.lock().await.remove(build.root);
        return None;
    }
    compile.duration_ms += link.duration_ms;
    Some(compile)
}

/// Forgets a session's resolved configuration with the session.
pub async fn forget(root: &Path) {
    RESOLVED.lock().await.remove(root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_module_is_built_directly() {
        assert_eq!(language_version("module atomis\n\ngo 1.22\n").as_deref(), Some("go1.22"));
        assert_eq!(language_version("// comment\nmodule atomis\ngo 1.23.4\n").as_deref(), Some("go1.23.4"));
        assert_eq!(language_version("module atomis\ngo 1.22\nrequire example.com/x v1.0.0\n"), None);
        assert_eq!(language_version("module atomis\ngo 1.22\ntoolchain go1.23.0\n"), None);
        assert_eq!(language_version("module atomis\n"), None);
    }

    #[test]
    fn imports_are_read_in_every_form_and_cgo_is_refused() {
        let source = "package main\n\nimport \"fmt\"\nimport (\n\t\"os\"\n\tstr \"strings\"\n\t_ \"embed\"\n)\n\nfunc main() { fmt.Println(\"import (\\\"not\\\")\") }\n";
        let found = imports(&[source.to_string()]).expect("imports");
        assert_eq!(found.into_iter().collect::<Vec<_>>(), ["embed", "fmt", "os", "strings"]);
        assert!(imports(&["package main\nimport \"C\"\n".to_string()]).is_none());
    }
}
