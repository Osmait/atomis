//! Dependency management: reading what a workspace declares, and the
//! per-language commands that add or remove one.
//!
//! Manifests are parsed rather than shelled out to, so listing is instant
//! and works offline. The parsers cover the shapes the tools themselves
//! write (that is how entries get there) plus the obvious hand-written
//! ones; anything exotic simply does not show up in the list, it is never
//! misread as something else.

use crate::protocol::Language;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: String,
    /// Version as declared; empty when the manifest does not pin one.
    pub version: String,
}

/// How one language adds, removes and records dependencies.
pub struct DepsSupport {
    /// Manifest holding the declarations, relative to the workspace root.
    pub manifest: &'static str,
    /// Command and leading args; the dependency is appended.
    pub add: &'static [&'static str],
    pub remove: &'static [&'static str],
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
}

pub fn support(language: Language) -> Option<&'static DepsSupport> {
    match language {
        Language::Rust => Some(&RUST),
        Language::Go => Some(&GO),
        Language::Ts => Some(&TS),
        _ => None,
    }
}

static RUST: DepsSupport = DepsSupport {
    manifest: "Cargo.toml",
    add: &["cargo", "add"],
    remove: &["cargo", "remove"],
    // The runners build with CARGO_NET_OFFLINE=true; adding needs the net.
    fetch_env: &[("CARGO_NET_OFFLINE", "false")],
    // `cargo add` writes the manifest and lock file but downloads nothing.
    fetch_after_add: Some(&["cargo", "fetch"]),
    runs_untrusted_code: false,
    input_hint: "crate name, optionally name@version",
};

static GO: DepsSupport = DepsSupport {
    manifest: "go.mod",
    add: &["go", "get"],
    remove: &["go", "get"],
    fetch_env: &[("GOPROXY", "https://proxy.golang.org,direct"), ("GOFLAGS", "-mod=mod")],
    // `go get` populates the module cache itself.
    fetch_after_add: None,
    runs_untrusted_code: false,
    input_hint: "module path, e.g. github.com/user/repo",
};

static TS: DepsSupport = DepsSupport {
    manifest: "package.json",
    add: &["npm", "install"],
    remove: &["npm", "uninstall"],
    fetch_env: &[],
    // `npm install` writes node_modules as it goes.
    fetch_after_add: None,
    // npm runs the package's own install scripts.
    runs_untrusted_code: true,
    input_hint: "package name, optionally name@version",
};

/// Go removes a module by asking for the null version.
pub fn remove_argument(language: Language, name: &str) -> String {
    match language {
        Language::Go => format!("{name}@none"),
        _ => name.to_string(),
    }
}

pub fn parse_manifest(language: Language, text: &str) -> Vec<Dependency> {
    match language {
        Language::Rust => parse_cargo_toml(text),
        Language::Go => parse_go_mod(text),
        Language::Ts => parse_package_json(text),
        _ => Vec::new(),
    }
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
        assert!(support(Language::Zig).is_none());
    }

    #[test]
    fn go_removes_by_asking_for_the_null_version() {
        assert_eq!(remove_argument(Language::Go, "example.com/x"), "example.com/x@none");
        assert_eq!(remove_argument(Language::Rust, "serde"), "serde");
    }
}
