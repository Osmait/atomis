//! Dependency management: reading what a workspace declares, and the
//! per-language commands that add or remove one.
//!
//! Manifests are parsed rather than shelled out to, so listing is instant
//! and works offline. The parsers cover the shapes the tools themselves
//! write (that is how entries get there) plus the obvious hand-written
//! ones; anything exotic simply does not show up in the list, it is never
//! misread as something else.

pub use crate::protocol::Dependency;
use crate::protocol::Language;

/// How one language adds, removes and records dependencies.
pub struct DepsSupport {
    /// Manifest holding the declarations, relative to the workspace root.
    pub manifest: &'static str,
    /// Command and leading args; the dependency is appended.
    pub add: &'static [&'static str],
    /// None where the toolchain has no remove command and Atomis edits the
    /// manifest itself (zig).
    pub remove: Option<&'static [&'static str]>,
    /// Env for the add step, which is the only one allowed to reach the
    /// network (the runners keep their offline flags for builds).
    pub fetch_env: &'static [(&'static str, &'static str)],
    /// Some tools only resolve and record on add, leaving the download to
    /// the next build — which runs offline. This command, when present,
    /// pulls the sources while the network is still open.
    pub fetch_after_add: Option<&'static [&'static str]>,
    /// Whether installing runs code written by the package author.
    pub runs_untrusted_code: bool,
    /// What the user types: a package name, or a URL for registry-less zig.
    pub input_hint: &'static str,
    /// Reads the manifest's declarations.
    pub parse: fn(&str) -> Vec<Dependency>,
    /// Rewrites the manifest without one entry, where Atomis edits it
    /// itself because the toolchain has no remove command.
    pub edit_out: Option<fn(&str, &str) -> Option<String>>,
    /// What to pass the remove command; go asks for the null version.
    pub remove_argument: fn(&str) -> String,
}

fn same_name(name: &str) -> String {
    name.to_string()
}

/// Go removes a module by asking for the null version.
fn go_null_version(name: &str) -> String {
    format!("{name}@none")
}

pub fn support(language: Language) -> Option<&'static DepsSupport> {
    crate::languages::packs::pack(language).deps
}

pub static RUST: DepsSupport = DepsSupport {
    manifest: "Cargo.toml",
    add: &["cargo", "add"],
    remove: Some(&["cargo", "remove"]),
    // The runners build with CARGO_NET_OFFLINE=true; adding needs the net.
    fetch_env: &[("CARGO_NET_OFFLINE", "false")],
    // `cargo add` writes the manifest and lock file but downloads nothing.
    fetch_after_add: Some(&["cargo", "fetch"]),
    runs_untrusted_code: false,
    input_hint: "crate name, optionally name@version",
    parse: parse_cargo_toml,
    edit_out: None,
    remove_argument: same_name,
};

pub static GO: DepsSupport = DepsSupport {
    manifest: "go.mod",
    add: &["go", "get"],
    remove: Some(&["go", "get"]),
    fetch_env: &[("GOPROXY", "https://proxy.golang.org,direct"), ("GOFLAGS", "-mod=mod")],
    // `go get` populates the module cache itself.
    fetch_after_add: None,
    runs_untrusted_code: false,
    input_hint: "module path, e.g. github.com/user/repo",
    parse: parse_go_mod,
    edit_out: None,
    remove_argument: go_null_version,
};

pub static TS: DepsSupport = DepsSupport {
    manifest: "package.json",
    add: &["npm", "install"],
    remove: Some(&["npm", "uninstall"]),
    fetch_env: &[],
    // `npm install` writes node_modules as it goes.
    fetch_after_add: None,
    // npm runs the package's own install scripts.
    runs_untrusted_code: true,
    input_hint: "package name, optionally name@version",
    parse: parse_package_json,
    edit_out: None,
    remove_argument: same_name,
};

/// Go removes a module by asking for the null version.
pub fn remove_argument(language: Language, name: &str) -> String {
    support(language).map_or_else(|| name.to_string(), |deps| (deps.remove_argument)(name))
}

pub static ZIG: DepsSupport = DepsSupport {
    manifest: "build.zig.zon",
    // Zig has no registry: a dependency is a URL, and the package's own
    // name in the fetched manifest is what the build then imports.
    add: &["zig", "fetch", "--save"],
    // There is no `zig fetch --remove`; Atomis rewrites the manifest.
    remove: None,
    fetch_env: &[],
    fetch_after_add: None,
    runs_untrusted_code: false,
    input_hint: "package URL, e.g. git+https://github.com/user/repo",
    parse: parse_build_zon,
    edit_out: Some(zon_without),
    remove_argument: same_name,
};

pub static PY: DepsSupport = DepsSupport {
    manifest: "pyproject.toml",
    // uv resolves, locks and installs into the workspace's own .venv.
    add: &["uv", "add"],
    remove: Some(&["uv", "remove"]),
    fetch_env: &[],
    fetch_after_add: None,
    // Building a wheel from source runs the package's build backend.
    runs_untrusted_code: true,
    input_hint: "package name, optionally name==version",
    parse: parse_pyproject,
    edit_out: None,
    remove_argument: same_name,
};

pub fn parse_manifest(language: Language, text: &str) -> Vec<Dependency> {
    support(language).map_or_else(Vec::new, |deps| (deps.parse)(text))
}

/// The `dependencies` array of a pyproject's `[project]` table, as uv
/// writes it: one requirement string per line, name first.
fn parse_pyproject(text: &str) -> Vec<Dependency> {
    let mut found = Vec::new();
    let mut in_project = false;
    let mut in_list = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_project = trimmed == "[project]";
            in_list = false;
            continue;
        }
        if !in_project {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("dependencies") {
            let rest = rest.trim_start_matches([' ', '=']).trim();
            in_list = !rest.ends_with(']');
            // A single-line `dependencies = ["a", "b"]` closes immediately.
            for requirement in rest.trim_matches(['[', ']']).split(',') {
                if let Some(dependency) = parse_requirement(requirement) {
                    found.push(dependency);
                }
            }
            continue;
        }
        if in_list {
            if trimmed.starts_with(']') {
                in_list = false;
                continue;
            }
            if let Some(dependency) = parse_requirement(trimmed) {
                found.push(dependency);
            }
        }
    }
    found
}

/// `"requests>=2.32.5"` becomes name `requests`, version `>=2.32.5`.
fn parse_requirement(raw: &str) -> Option<Dependency> {
    let requirement = raw.trim().trim_end_matches(',').trim_matches('"').trim();
    if requirement.is_empty() || requirement.starts_with('#') {
        return None;
    }
    let split = requirement
        .find(|c: char| "<>=!~[ ".contains(c))
        .unwrap_or(requirement.len());
    let (name, version) = requirement.split_at(split);
    (!name.is_empty()).then(|| Dependency {
        name: name.to_string(),
        version: version.trim().to_string(),
    })
}

/// The `.dependencies` block of a build.zig.zon. The hash zig writes
/// carries `name-version-digest`, which is where the version shown comes
/// from — the manifest records no version field of its own.
fn parse_build_zon(text: &str) -> Vec<Dependency> {
    let Some(start) = text.find(".dependencies") else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut depth = 0i32;
    let mut current: Option<String> = None;
    for line in text[start..].lines().skip(1) {
        let trimmed = line.trim();
        // An entry opens at the block's first level: `.name = .{`.
        if depth == 0 {
            if let Some(name) = trimmed
                .strip_prefix('.')
                .and_then(|rest| rest.split('=').next())
                .map(str::trim)
                .filter(|name| !name.is_empty() && trimmed.ends_with(".{"))
            {
                current = Some(name.to_string());
                depth = 1;
                found.push(Dependency {
                    name: name.to_string(),
                    version: String::new(),
                });
                continue;
            }
            // `},` at this level closes the whole dependencies block.
            if trimmed.starts_with('}') {
                break;
            }
            continue;
        }
        if trimmed.starts_with('}') {
            depth = 0;
            current = None;
            continue;
        }
        // `.hash = "clap-0.12.0-oBaj…"` — the middle field is the version.
        if let (Some(name), Some(hash)) = (
            current.as_ref(),
            trimmed
                .strip_prefix(".hash")
                .and_then(|rest| rest.split('"').nth(1)),
        ) {
            let version = hash.split('-').nth(1).unwrap_or_default();
            if let Some(entry) = found.iter_mut().find(|entry| &entry.name == name) {
                entry.version = version.to_string();
            }
        }
    }
    found
}

/// Removes one dependency from a build.zig.zon, returning the new text.
/// Used where the toolchain offers no remove command.
pub fn manifest_without(language: Language, text: &str, name: &str) -> Option<String> {
    let edit = support(language).and_then(|deps| deps.edit_out)?;
    edit(text, name)
}

/// Drops one `.name = .{ … }` block from a build.zig.zon.
fn zon_without(text: &str, name: &str) -> Option<String> {
    let opener = format!(".{name} = .{{");
    let mut out = String::with_capacity(text.len());
    let mut skipping = false;
    let mut depth = 0i32;
    for line in text.lines() {
        if !skipping && line.trim().starts_with(&opener) {
            skipping = true;
            depth = 1;
            continue;
        }
        if skipping {
            depth += line.matches('{').count() as i32;
            depth -= line.matches('}').count() as i32;
            if depth <= 0 {
                skipping = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    (out != text).then_some(out)
}

fn strip_quotes(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

/// `[dependencies]` entries plus `[dependencies.name]` tables — the two
/// shapes `cargo add` produces.
fn parse_cargo_toml(text: &str) -> Vec<Dependency> {
    let mut found: Vec<Dependency> = Vec::new();
    let mut in_dependencies = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_dependencies = line == "[dependencies]";
            // `[dependencies.serde]` declares one by section name.
            if let Some(name) = line
                .strip_prefix("[dependencies.")
                .and_then(|rest| rest.strip_suffix(']'))
            {
                found.push(Dependency {
                    name: name.trim().to_string(),
                    version: String::new(),
                });
            }
            continue;
        }
        if !in_dependencies || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let value = value.trim();
        let version = if value.starts_with('{') {
            // Inline table: pick out version = "…" when present. Splitting
            // on commas can cut inside a features array, but no fragment of
            // one starts with `version`, so the search stays correct.
            value
                .trim_start_matches('{')
                .trim_end_matches('}')
                .split(',')
                .find_map(|part| part.trim().strip_prefix("version"))
                .and_then(|part| part.split_once('='))
                .map(|(_, version)| strip_quotes(version.trim_end_matches('}')))
                .unwrap_or_default()
        } else {
            strip_quotes(value)
        };
        found.push(Dependency {
            name: name.to_string(),
            version,
        });
    }
    // A `[dependencies.x]` table may also appear after its own entry.
    found.dedup_by(|left, right| left.name == right.name);
    found
}

/// `require` lines, single or inside a block; indirect ones are the
/// module graph's business, not the user's.
fn parse_go_mod(text: &str) -> Vec<Dependency> {
    let mut found = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("require (") {
            in_block = true;
            continue;
        }
        if in_block && line == ")" {
            in_block = false;
            continue;
        }
        if line.contains("// indirect") {
            continue;
        }
        let entry = if in_block {
            line
        } else if let Some(rest) = line.strip_prefix("require ") {
            rest
        } else {
            continue;
        };
        let mut parts = entry.split_whitespace();
        let (Some(name), Some(version)) = (parts.next(), parts.next()) else {
            continue;
        };
        if name.is_empty() || name.starts_with("//") {
            continue;
        }
        found.push(Dependency {
            name: name.to_string(),
            version: version.to_string(),
        });
    }
    found
}

fn parse_package_json(text: &str) -> Vec<Dependency> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for section in ["dependencies", "devDependencies"] {
        let Some(entries) = parsed.get(section).and_then(|value| value.as_object()) else {
            continue;
        };
        for (name, version) in entries {
            found.push(Dependency {
                name: name.clone(),
                version: version.as_str().unwrap_or_default().to_string(),
            });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shapes_cargo_add_writes() {
        let manifest = r#"
[package]
name = "atomis_session"

[dependencies]
serde = "1.0.200"
rand = { version = "0.8", features = ["small_rng"] }
# commented = "9"
local = { path = "../thing" }

[dependencies.tokio]
version = "1"
features = ["full"]

[profile.dev]
debug = 0
"#;
        let found = parse_manifest(Language::Rust, manifest);
        assert_eq!(
            found
                .iter()
                .map(|dep| (dep.name.as_str(), dep.version.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("serde", "1.0.200"),
                ("rand", "0.8"),
                // A path dependency has no version to show.
                ("local", ""),
                ("tokio", ""),
            ]
        );
        // Nothing from [package] or [profile.dev] leaks in.
        assert!(found.iter().all(|dep| dep.name != "name" && dep.name != "debug"));
    }

    #[test]
    fn reads_go_requires_and_skips_indirect_ones() {
        let manifest = r#"
module atomis

go 1.22

require github.com/google/uuid v1.6.0

require (
	golang.org/x/exp v0.0.0-20240506
	github.com/pkg/errors v0.9.1 // indirect
)
"#;
        assert_eq!(
            parse_manifest(Language::Go, manifest),
            vec![
                Dependency {
                    name: "github.com/google/uuid".into(),
                    version: "v1.6.0".into()
                },
                Dependency {
                    name: "golang.org/x/exp".into(),
                    version: "v0.0.0-20240506".into()
                },
            ]
        );
    }

    #[test]
    fn reads_both_dependency_sections_of_package_json() {
        let manifest = r#"{
            "name": "atomis-session",
            "dependencies": { "zod": "^3.23.0" },
            "devDependencies": { "typescript": "5.9.3" }
        }"#;
        let found = parse_manifest(Language::Ts, manifest);
        assert_eq!(found.len(), 2);
        assert!(found.contains(&Dependency {
            name: "zod".into(),
            version: "^3.23.0".into()
        }));
        assert!(found.contains(&Dependency {
            name: "typescript".into(),
            version: "5.9.3".into()
        }));
    }

    #[test]
    fn a_broken_manifest_lists_nothing_instead_of_guessing() {
        assert!(parse_manifest(Language::Ts, "{ not json").is_empty());
        assert!(parse_manifest(Language::Rust, "").is_empty());
        // Languages without a package manager have no support entry.
        assert!(support(Language::C).is_none());
        assert!(parse_manifest(Language::Zig, "not a zon").is_empty());
    }

    const ZON: &str = r#".{
    .name = .atomis_session,
    .version = "0.0.0",
    .dependencies = .{
        .clap = .{
            .url = "git+https://github.com/Hejsil/zig-clap#e91d66b",
            .hash = "clap-0.12.0-oBajB2LpAQD1BQpAukHcuwhIUoHWYNy2DzU6lDW2v2N8",
        },
        .zul = .{
            .url = "git+https://github.com/karlseguin/zul",
            .hash = "zul-0.1.0-abcdefghijklmnop",
        },
    },
    .fingerprint = 0x5e5012a62cd7f022,
    .paths = .{ "build.zig", "src" },
}
"#;

    #[test]
    fn reads_zon_dependencies_with_the_version_from_the_hash() {
        assert_eq!(
            parse_manifest(Language::Zig, ZON),
            vec![
                Dependency {
                    name: "clap".into(),
                    version: "0.12.0".into()
                },
                Dependency {
                    name: "zul".into(),
                    version: "0.1.0".into()
                },
            ]
        );
        // Neither .paths nor .fingerprint are dependencies.
        let empty = parse_manifest(Language::Zig, ".{ .name = .x, .paths = .{ \"build.zig\" } }");
        assert!(empty.is_empty());
    }

    #[test]
    fn removing_from_the_zon_drops_only_that_entry() {
        let without = manifest_without(Language::Zig, ZON, "clap").expect("edited");
        assert!(!without.contains("clap"));
        assert!(without.contains(".zul = .{"));
        // The rest of the manifest survives intact.
        assert!(without.contains(".fingerprint = 0x5e5012a62cd7f022"));
        assert!(without.contains(".paths = .{ \"build.zig\", \"src\" }"));
        assert_eq!(
            parse_manifest(Language::Zig, &without),
            vec![Dependency {
                name: "zul".into(),
                version: "0.1.0".into()
            }]
        );
        // A name that is not there changes nothing.
        assert!(manifest_without(Language::Zig, ZON, "absent").is_none());
        // Other languages have their own remove command.
        assert!(manifest_without(Language::Rust, ZON, "clap").is_none());
    }

    #[test]
    fn reads_the_requirements_uv_writes() {
        let manifest = r#"
[project]
name = "atomis-session"
requires-python = ">=3.9"
dependencies = [
    "requests>=2.32.5",
    "httpx[http2]==0.27",
    # a comment
]

[tool.uv]
dev-dependencies = ["pytest"]
"#;
        let found = parse_manifest(Language::Py, manifest);
        assert_eq!(
            found
                .iter()
                .map(|dep| (dep.name.as_str(), dep.version.as_str()))
                .collect::<Vec<_>>(),
            vec![("requests", ">=2.32.5"), ("httpx", "[http2]==0.27")]
        );
        // requires-python is not a dependency, and neither is [tool.uv].
        assert!(found.iter().all(|dep| dep.name != "requires-python" && dep.name != "pytest"));
    }

    #[test]
    fn reads_a_single_line_dependency_list() {
        let found = parse_manifest(
            Language::Py,
            "[project]\ndependencies = [\"rich\", \"typer>=0.12\"]\n",
        );
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "rich");
        assert_eq!(found[1].version, ">=0.12");
    }

    #[test]
    fn go_removes_by_asking_for_the_null_version() {
        assert_eq!(remove_argument(Language::Go, "example.com/x"), "example.com/x@none");
        assert_eq!(remove_argument(Language::Rust, "serde"), "serde");
    }
}
