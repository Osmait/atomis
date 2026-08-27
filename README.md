# Atomis

A loopback-only **Zig, Rust, Go, TypeScript/JavaScript, Python, C and C++** playground inspired by RunJS: Monaco + real language servers (ZLS / rust-analyzer), cancellable native compilation/execution, per-test results, and inline local values produced by AST instrumentation without changing visible code.

> **Code runs locally with your permissions.** Atomis is not a security sandbox. Pause Auto Run before pasting untrusted code.

## Requirements

- Linux or macOS
- Node.js 22 (23/24 accepted for development)
- Zig 0.16.x on `PATH`
- ZLS 0.16.x on `PATH`
- Optional, enables Rust sessions: Rust 1.75+ (`rustc`/`cargo`) and `rust-analyzer` on `PATH`
- Optional, enables Go sessions: Go 1.22+ and `gopls` on `PATH`
- TS/JS sessions use the required Node itself (22.18+ for type stripping); `typescript-language-server` on `PATH` is optional for editor features
- Optional, enables Python sessions: Python 3.9+ on `PATH`; `pyright-langserver` is optional for editor features
- Optional, enables C/C++ sessions: clang/clang++ 15+ on `PATH` (also used by the instrumenter's AST dump); `clangd` is optional for editor features
- Corepack/pnpm 11.24.0

Atomis never downloads toolchains at runtime. Releases: <https://ziglang.org/download/>, <https://zigtools.org/zls/releases/0.16.0/> and <https://rustup.rs>. The Rust instrumenter's crates (`syn`, `proc-macro2`, `quote`, `unicode-ident`) are vendored in `rust/instrumenter/vendor/` so builds stay offline.

Pinned application stack: React 19.2.8, Monaco Editor 0.56.0, Monaco Vim 0.4.4, Vite 8.2.2, Fastify 5.12.1, `ws` 8.21.3, Zod 4.4.3 and TypeScript 7.0.2. Exact resolutions are recorded in `pnpm-lock.yaml`.

## Install and verify

```bash
corepack enable
pnpm install
pnpm run doctor
```

`pnpm` 11 reserves `pnpm doctor` for pnpm's own environment doctor, so use the explicit package-script spelling `pnpm run doctor` for the Atomis doctor.

## Development

```bash
pnpm dev
```

This first builds `runzig-instrument` and the shared protocol, then starts:

- UI: <http://127.0.0.1:5173>
- orchestrator: `127.0.0.1:4317` (Rust/axum, proxied by Vite)

Override the server port with `ATOMIS_PORT`; update the Vite proxy when using a non-default development port.

## Test and production

```bash
pnpm test
pnpm exec playwright install chromium   # once per machine
pnpm test:e2e
pnpm build
pnpm start
```

Production is served at <http://127.0.0.1:4317>. `pnpm start` expects `pnpm build` to have completed.

Useful focused commands:

```bash
zig build test
cargo test --manifest-path apps/server-rs/Cargo.toml
pnpm --filter @atomis/web test
pnpm typecheck
pnpm lint    # oxlint (strict, no any/unknown) + cargo clippy -D warnings
```

## CI/CD

GitHub Actions (patterns borrowed from GitButler and Clash Verge Rev):

- **CI** (`.github/workflows/ci.yml`, push/PR): three parallel jobs — lint + typecheck (oxlint strict over web/protocol/e2e/scripts with `any`/`unknown` banned, `cargo clippy -D warnings`, `tsc` incl. the e2e suite), unit/instrumenter tests (`pnpm test` with zig/go/rust toolchains), and the full 25-spec Playwright suite against the real stack (zig 0.16.0 + zls 0.16.0 pinned by sha256, traces uploaded on failure).
- **Release** (`.github/workflows/release.yml`, manual): Actions → Release → Run workflow with a semver bump (patch/minor/major). It versions every manifest in lockstep via `scripts/bump-version.mjs` (package.json ×4, tauri.conf.json, both Cargo.toml/Cargo.lock), commits + tags `vX.Y.Z`, builds the Tauri bundles for **Linux x86_64** (AppImage/deb/rpm) and **macOS Apple Silicon** (dmg), and publishes the GitHub Release with generated notes. The macOS build is unsigned: first open via right click → Open.

## Desktop app (Tauri)

`apps/desktop` wraps Atomis in a Tauri v2 window with the Rust server embedded as a **sidecar**: a ~5 MB native binary (`binaries/atomis-server-<triple>`) that picks a free port, announces it on stdout, and serves the API, the WebSockets and the built web UI; the window navigates to it once ready. Instrumenters, session templates and runtimes ship as bundle resources (`ATOMIS_ROOT` points the server at them). Language toolchains (zig, cargo, go, node, python3, clang) are still taken from the host machine — the doctor/degraded flow applies as in the browser.

```sh
pnpm desktop:build                           # toolchains + web build + Rust sidecar + resources
pnpm --filter @atomis/desktop bundle:linux  # AppImage/deb/rpm (use NO_STRIP=true if linuxdeploy fails)
pnpm --filter @atomis/desktop bundle:mac    # .app / .dmg
pnpm --filter @atomis/desktop dev           # dev window against the Vite dev server (pnpm dev first)
```

Bundles land in `apps/desktop/src-tauri/target/release/bundle/`. The backend rewrite in Rust (axum, same WS protocol) will replace the sidecar later.

## Usage

The UI is a Catppuccin workspace of joined panels (native-window style): a file-tree sidebar, the editor (tabs, auto, settings gear and an icon Run button in its chrome row) and a dockable terminal, with a status bar (mode chip, run state, path, timings, cursor). The settings modal (gear or **⌘,**) holds the behaviour toggles (including **Inline logs** — Console Ninja-style: each print/log statement shows its latest output as ghost text beside the line, with a ×count for loops and hover for history, in every language), the inline-value format, the theme (Mocha / Macchiato / Crust) and typography (JetBrains Mono / IBM Plex Mono / SF Mono, sizes 12–15) — all persisted.

New sessions start **minimal**: just the entry file of your last-used language. The tree's ⋯ menu offers **Load demo workspace** — the entry file of every language whose toolchain is present, with example tests — and **Clear workspace** to go back to a single fresh file. Every workspace is **multilingual by extension** either way: create `main.rs`, `main.py`, … and they run (`main.zig`, `main.rs`, `main.go`, `main.ts`, `main.py`, `main.c`, `main.cpp` and their test files), and the file you are editing decides everything — Run (and Auto Run after an edit) executes that file's language pipeline, ZLS and rust-analyzer run side by side routed by extension, and assets like `input.txt` are shared between both. The status bar and terminal prompt reflect the active file's language, and the last language you touched is remembered for the next session. Rust runs use `cargo build`/`cargo run` with structured `--message-format=json` diagnostics, `#[test]` functions in the tests panel, and the same inline probe values and log-source tracing via `rustlive-instrument`.

Keyboard navigation is vim-flavoured app-wide: a configurable **leader key** (Space by default; `,` or `\` in Settings → Keyboard) works from vim Normal mode in the editor and anywhere outside it — **leader+e** focuses the file tree and closes it when already focused (j/k move, Enter opens, h/l fold/unfold, Esc back), **leader+t** does the same for the terminal (j/k/d/u scroll, G bottom), **leader+h / leader+l** move focus across panels (tree ← editor → terminal), **leader+o** closes every tab but the active one, and **Shift+H / Shift+L** cycle through the open tabs. The status-bar mode chip shows LEADER/TREE/TERMINAL while navigating. Files and folders are created and renamed inline in the tree (VS Code style — type the name, Enter confirms, Esc cancels), from the ⋯ menu, the right-click context menu, or a folder's hover ＋.

Keyboard: **Ctrl/Cmd+Enter** run · **Ctrl/Cmd+S** format the document (ZLS / rust-analyzer) and return Vim to Normal mode · **Ctrl/Cmd+B** toggle tree · **Ctrl/Cmd+J** toggle terminal · **Ctrl/Cmd+K** command palette (open, or ⌘↵ open-and-run, or create a file by typing a new name) · **Ctrl/Cmd+T** tests drawer · **Ctrl/Cmd+,** settings · **Ctrl/Cmd+1–5** inline-value format (dec/hex/bin/oct/chr) · **Ctrl/Cmd+.** zen mode. Layout (dock side, tree, zen) persists in the browser.

- Create, open, rename and delete files — and organize them in folders — from the project tree or the palette (type `folder/file.ext`; the `＋/` button creates an empty folder that materializes with its first file). Folders collapse, and their badge aggregates failing tests. Tabs preserve Monaco models and can be closed with ✕; Zig modules can import one another with relative `@import` paths.
- `test "…"` blocks (Zig), `#[test]` functions (Rust), `func TestXxx` in `*_test.go` (Go, via `go test -json`) `test()`/`it()` in `*.test.ts|js` (node:test, TAP) `def test_*` in `test_*.py`/`*_test.py` (custom stdlib runner) and `void test_*` in `*_test.c|cpp` (a generated test main compiled with `-Dmain` so functions in `main.c` stay testable) run automatically after the program: the tests drawer shows per-test rows (pass/fail/skip/leak, duration, click to jump), the editor shows an error-lens result at the end of each test line, the tree shows failing counts per file, and the last four runs appear under the drawer's History tab.
- ZLS diagnostics, completion, hover, definition, formatting, semantic tokens, inlay hints and code actions work across opened `.zig` files when advertised.
- Auto Run debounces edits for 400 ms. **Ctrl/Cmd+Enter** runs immediately; clicking the Run button while it spins cancels the active run.
- Vim Mode is enabled by default and can be toggled in the settings modal (⌘,). Use `i` to insert, `Esc` for Normal mode and `:w` to run the current source. Native Ctrl/Cmd+A/C/X/V shortcuts and the editor's right-click Copy/Paste menu remain available. On top of monaco-vim's full keymap (motions, operators, text objects, visual block, marks, registers, macros, `/` search, `:s`), Atomis adds: **f/t assistance** — while `f`/`F`/`t`/`T` awaits its character, the landing spot of every word on that side is underlined (quick-scope); once the character is typed, every match of that character stays lit while `;`/`,` repeat the jump (clever-f) — plus LSP/editor keys `gd` (definition), `gr` (references), `K` (hover docs), `gcc`/visual `gc` (comment), `za`/`zc`/`zo`/`zR`/`zM` (folding), visual `=` (LSP format), `ZZ` (run), and ex commands `:e <file>` (open/create), `:bd` (close tab), `:only` (close the others).
- Auto Inspect adds probes to supported local declarations in every `.zig` module under `generated/`. Click declaration glyphs for manual probes.
- Inline values become crossed-out/stale immediately after an edit. Only matching document-version events can replace them.
- **Low-level mode**: the `Inline values` switcher in settings (or ⌘1–5) re-formats integer inline values as dec/hex/bin/oct/chr using each value's real bit width. Clicking an inline value opens a peek panel anchored under the line with the value's bit grid (click a bit for a local what-if — the program never changes), little-endian memory bytes, size/align, base conversions and — for Zig structs — the compiler-real field table (`@offsetOf`/`@sizeOf` per field). Zig re-probes assignments (`flags <<= 1;`), so bit operations show their `A · op · B = result` rows; Rust/Go/C/C++ report size/align/bit-width via `size_of_val`, `reflect` and `sizeof`/`_Alignof`.
- The terminal resets at the start of every run; its ⋮ menu docks it right or bottom, maximizes, switches between Output/Problems/Runtime, clears or closes it. The slim **Tests** bar at its bottom (one mini bar per test plus the score) expands into the tests drawer (⌘T): big score, per-test rows with jump-to-line, failure messages, and the run history under its History tab. The drawer opens itself when tests fail. Runs of four or more log lines from the same statement and panic traces collapse into expandable ▸ folds. Program output is neutral; compiler/runtime failures are red. Hover output produced by `std.debug.print` or `std.log` to highlight its source line; click to pin the highlight and move the editor there. Repeated loop logs show their execution number, enclosing loop line, and detected loop variable/value. Diagnostics and Runtime retain owner and timing details.

## Workspace

Each browser session gets `/tmp/atomis/<random-id>/` with a visible multi-file `src/` project, a generated mirror, runtime/source maps, `build.zig`, a local cache and output. Text assets are mirrored so `@embedFile("input.txt")` works; execution uses `src/` as cwd so runtime reads such as `readFileAlloc(..., "input.txt", ...)` work too. Projects are capped at 64 files and 8 MiB. Session IDs and bearer tokens are random; absolute paths and traversal segments are rejected. Workspaces are removed on disconnect/shutdown and abandoned directories older than 24 hours are removed at startup.

## Credits

File, folder and language icons come from [material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT), bundled at build time — no icon CDN is used. The vendored Rust crates under `rust/instrumenter/vendor/` keep their original MIT/Apache-2.0 licenses.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocols](docs/protocols.md)
- [Instrumentation](docs/instrumentation.md)
- [Limitations/security](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Implementation decisions](docs/implementation-plan.md)
