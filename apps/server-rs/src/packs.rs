//! Language pack registry mirrored from apps/server/src/languages/registry.ts:
//! per-language metadata, toolchain checks, scaffolding and instrumenter paths.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use crate::protocol::{Language, LANGUAGES};

pub struct ToolCheck {
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub compatible: fn(&str) -> bool,
    pub expected: &'static str,
}

pub struct LanguagePack {
    pub id: Language,
    pub extensions: &'static [&'static str],
    pub entry_file: &'static str,
    pub default_source: &'static str,
    pub extra_files: &'static [(&'static str, &'static str)],
    pub scaffold_always: bool,
    pub run: ToolCheck,
    pub lsp: Option<ToolCheck>,
    pub lsp_command: Option<&'static str>,
}

pub fn project_root() -> PathBuf {
    match std::env::var("ATOMIS_ROOT") {
        Ok(root) => PathBuf::from(root),
        // Dev fallback: this crate lives at <root>/apps/server-rs.
        Err(_) => Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
    }
}

fn zig_compatible(version: &str) -> bool {
    version.starts_with("0.16.")
}

fn zls_compatible(version: &str) -> bool {
    version.starts_with("0.16.")
}

pub fn cargo_compatible(version: &str) -> bool {
    let Some(rest) = version.strip_prefix("cargo ") else {
        return false;
    };
    let mut parts = rest.split(['.', ' ', '-']);
    let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    major > 1 || (major == 1 && minor >= 75)
}

fn rust_analyzer_compatible(version: &str) -> bool {
    version.starts_with("rust-analyzer")
}

fn go_compatible(version: &str) -> bool {
    let Some(index) = version.find("go version go1.") else {
        return false;
    };
    let rest = &version[index + "go version go1.".len()..];
    let minor: u32 = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    minor >= 22
}

fn gopls_compatible(version: &str) -> bool {
    version.to_lowercase().contains("gopls")
}

pub fn node_compatible(version: &str) -> bool {
    let Some(rest) = version.strip_prefix('v') else {
        return false;
    };
    let mut parts = rest.split('.');
    let major: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    major >= 23 || (major == 22 && minor >= 18)
}

fn any_digit(version: &str) -> bool {
    version.chars().any(|c| c.is_ascii_digit())
}

fn python_compatible(version: &str) -> bool {
    let Some(index) = version.find("Python 3.") else {
        return false;
    };
    let rest = &version[index + "Python 3.".len()..];
    let minor: u32 = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    minor >= 9
}

fn clang_compatible(version: &str) -> bool {
    let Some(index) = version.find("clang version ") else {
        return false;
    };
    let rest = &version[index + "clang version ".len()..];
    let major: u32 = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    major >= 15
}

fn clangd_compatible(version: &str) -> bool {
    version.to_lowercase().contains("clangd")
}

pub static PACKS: [LanguagePack; 7] = [
    LanguagePack {
        id: Language::Zig,
        extensions: &[".zig"],
        entry_file: "main.zig",
        default_source: crate::protocol::DEFAULT_ZIG_SOURCE,
        extra_files: &[],
        scaffold_always: true,
        run: ToolCheck {
            command: "zig",
            args: &["version"],
            compatible: zig_compatible,
            expected: "Zig 0.16.x",
        },
        lsp: Some(ToolCheck {
            command: "zls",
            args: &["--version"],
            compatible: zls_compatible,
            expected: "ZLS 0.16.x",
        }),
        lsp_command: Some("zls"),
    },
    LanguagePack {
        id: Language::Rust,
        extensions: &[".rs"],
        entry_file: "main.rs",
        default_source: crate::protocol::DEFAULT_RUST_SOURCE,
        extra_files: &[],
        scaffold_always: false,
        run: ToolCheck {
            command: "cargo",
            args: &["--version"],
            compatible: cargo_compatible,
            expected: "Rust 1.75+",
        },
        lsp: Some(ToolCheck {
            command: "rust-analyzer",
            args: &["--version"],
            compatible: rust_analyzer_compatible,
            expected: "rust-analyzer",
        }),
        lsp_command: Some("rust-analyzer"),
    },
    LanguagePack {
        id: Language::Go,
        extensions: &[".go"],
        entry_file: "main.go",
        default_source: crate::protocol::DEFAULT_GO_SOURCE,
        extra_files: &[("main_test.go", crate::protocol::DEFAULT_GO_TEST_SOURCE)],
        scaffold_always: false,
        run: ToolCheck {
            command: "go",
            args: &["version"],
            compatible: go_compatible,
            expected: "Go 1.22+",
        },
        lsp: Some(ToolCheck {
            command: "gopls",
            args: &["version"],
            compatible: gopls_compatible,
            expected: "gopls",
        }),
        lsp_command: Some("gopls"),
    },
    LanguagePack {
        id: Language::Ts,
        extensions: &[".ts", ".js", ".mjs"],
        entry_file: "main.ts",
        default_source: crate::protocol::DEFAULT_TS_SOURCE,
        extra_files: &[("main.test.ts", crate::protocol::DEFAULT_TS_TEST_SOURCE)],
        scaffold_always: false,
        run: ToolCheck {
            command: "node",
            args: &["--version"],
            compatible: node_compatible,
            expected: "Node 22.18+ (type stripping)",
        },
        lsp: Some(ToolCheck {
            command: "typescript-language-server",
            args: &["--version"],
            compatible: any_digit,
            expected: "typescript-language-server",
        }),
        lsp_command: Some("typescript-language-server"),
    },
    LanguagePack {
        id: Language::Py,
        extensions: &[".py"],
        entry_file: "main.py",
        default_source: crate::protocol::DEFAULT_PY_SOURCE,
        extra_files: &[("main_test.py", crate::protocol::DEFAULT_PY_TEST_SOURCE)],
        scaffold_always: false,
        run: ToolCheck {
            command: "python3",
            args: &["--version"],
            compatible: python_compatible,
            expected: "Python 3.9+",
        },
        lsp: Some(ToolCheck {
            command: "pyright-langserver",
            args: &["--version"],
            compatible: any_digit,
            expected: "pyright-langserver",
        }),
        lsp_command: Some("pyright-langserver"),
    },
    LanguagePack {
        id: Language::C,
        extensions: &[".c"],
        entry_file: "main.c",
        default_source: crate::protocol::DEFAULT_C_SOURCE,
        extra_files: &[("main_test.c", crate::protocol::DEFAULT_C_TEST_SOURCE)],
        scaffold_always: false,
        run: ToolCheck {
            command: "clang",
            args: &["--version"],
            compatible: clang_compatible,
            expected: "clang 15+",
        },
        lsp: Some(ToolCheck {
            command: "clangd",
            args: &["--version"],
            compatible: clangd_compatible,
            expected: "clangd",
        }),
        lsp_command: Some("clangd"),
    },
    LanguagePack {
        id: Language::Cpp,
        extensions: &[".cpp", ".cc"],
        entry_file: "main.cpp",
        default_source: crate::protocol::DEFAULT_CPP_SOURCE,
        extra_files: &[("main_test.cpp", crate::protocol::DEFAULT_CPP_TEST_SOURCE)],
        scaffold_always: false,
        run: ToolCheck {
            command: "clang++",
            args: &["--version"],
            compatible: clang_compatible,
            expected: "clang++ 15+",
        },
        lsp: Some(ToolCheck {
            command: "clangd",
            args: &["--version"],
            compatible: clangd_compatible,
            expected: "clangd",
        }),
        lsp_command: Some("clangd"),
    },
];

pub fn pack(language: Language) -> &'static LanguagePack {
    PACKS
        .iter()
        .find(|p| p.id == language)
        .expect("pack registered for every language")
}

pub fn pack_for_path(path: &str) -> Option<&'static LanguagePack> {
    PACKS
        .iter()
        .find(|p| p.extensions.iter().any(|ext| path.ends_with(ext)))
}

pub fn instrumenter_path(language: Language) -> PathBuf {
    let root = project_root();
    match language {
        Language::Zig => root.join("zig-out/bin/runzig-instrument"),
        Language::Rust => root.join("rust/instrumenter/target/release/rustlive-instrument"),
        Language::Go => root.join("go/instrumenter/bin/golive-instrument"),
        Language::Ts => root.join("ts/instrumenter/instrument.mjs"),
        Language::Py => root.join("python/instrumenter/pylive_instrument.py"),
        Language::C | Language::Cpp => root.join("cfamily/instrumenter/clive-instrument.mjs"),
    }
}

pub fn lsp_args(language: Language, root: &Path) -> Vec<String> {
    match language {
        Language::Zig => vec![
            "--config-path".into(),
            format!("{}/zls.json", root.to_string_lossy()),
        ],
        Language::Ts | Language::Py => vec!["--stdio".into()],
        _ => vec![],
    }
}

/// Copies the per-language session template files into a fresh session root.
pub async fn scaffold(language: Language, root: &Path) -> std::io::Result<()> {
    let source = project_root();
    let copy = |from: PathBuf, to: PathBuf| async move { tokio::fs::copy(from, to).await };
    match language {
        Language::Zig => {
            copy(
                source.join("zig/session-template/build.zig"),
                root.join("build.zig"),
            )
            .await?;
            copy(
                source.join("zig/session-template/build.zig.zon"),
                root.join("build.zig.zon"),
            )
            .await?;
            copy(
                source.join("zig/session-template/zls.json"),
                root.join("zls.json"),
            )
            .await?;
            copy(
                source.join("zig/runtime/runzig_runtime.zig"),
                root.join("generated/runzig_runtime.zig"),
            )
            .await?;
            copy(
                source.join("zig/test-runner/runzig_test_runner.zig"),
                root.join("runzig_test_runner.zig"),
            )
            .await?;
            tokio::fs::write(root.join("test_root.zig"), "comptime {}\n").await?;
        }
        Language::Rust => {
            copy(
                source.join("rust/session-template/Cargo.toml"),
                root.join("Cargo.toml"),
            )
            .await?;
            copy(
                source.join("rust/runtime/atomis_runtime.rs"),
                root.join("generated/atomis_runtime.rs"),
            )
            .await?;
        }
        Language::Go => {
            copy(
                source.join("go/session-template/go.mod"),
                root.join("go.mod"),
            )
            .await?;
            copy(
                source.join("go/runtime/atomis_runtime.go"),
                root.join("generated/atomis_runtime.go"),
            )
            .await?;
        }
        Language::Ts => {
            copy(
                source.join("ts/session-template/package.json"),
                root.join("package.json"),
            )
            .await?;
            copy(
                source.join("ts/runtime/atomis_runtime.mjs"),
                root.join("generated/__atomis_runtime.mjs"),
            )
            .await?;
            let type_roots = source
                .join("node_modules/@types")
                .to_string_lossy()
                .replace('\\', "/");
            let tsconfig = format!(
                "{}\n",
                serde_json::to_string_pretty(&serde_json::json!({
                    "compilerOptions": {
                        "strict": true,
                        "noEmit": true,
                        "target": "ES2023",
                        "module": "nodenext",
                        "moduleResolution": "nodenext",
                        "allowImportingTsExtensions": true,
                        "skipLibCheck": true,
                        "allowJs": true,
                        "typeRoots": [type_roots],
                        "types": ["node"],
                    },
                    "include": ["src"],
                }))
                .expect("static json")
                .replace("  ", "\t")
            );
            tokio::fs::write(root.join("tsconfig.json"), tsconfig).await?;
        }
        Language::Py => {
            copy(
                source.join("python/runtime/sitecustomize.py"),
                root.join("generated/sitecustomize.py"),
            )
            .await?;
        }
        Language::C => {
            copy(
                source.join("cfamily/runtime/atomis_runtime.h"),
                root.join("generated/atomis_runtime.h"),
            )
            .await?;
        }
        Language::Cpp => {
            copy(
                source.join("cfamily/runtime/atomis_runtime.hpp"),
                root.join("generated/atomis_runtime.hpp"),
            )
            .await?;
        }
    }
    Ok(())
}

pub fn all_languages() -> impl Iterator<Item = Language> {
    LANGUAGES.iter().copied()
}
