# ZigLive

A loopback-only **Zig, Rust, Go, TypeScript/JavaScript and Python** playground inspired by RunJS: Monaco + real language servers (ZLS / rust-analyzer), cancellable native compilation/execution, per-test results, and inline local values produced by AST instrumentation without changing visible code.

> **El código se ejecuta localmente con tus permisos.** ZigLive is not a security sandbox. Pause Auto Run before pasting untrusted code.

## Requirements

- Linux or macOS
- Node.js 22 (23/24 accepted for development)
- Zig 0.16.x on `PATH`
- ZLS 0.16.x on `PATH`
- Optional, enables Rust sessions: Rust 1.75+ (`rustc`/`cargo`) and `rust-analyzer` on `PATH`
- Optional, enables Go sessions: Go 1.22+ and `gopls` on `PATH`
- TS/JS sessions use the required Node itself (22.18+ for type stripping); `typescript-language-server` on `PATH` is optional for editor features
- Optional, enables Python sessions: Python 3.9+ on `PATH`; `pyright-langserver` is optional for editor features
- Corepack/pnpm 11.24.0

ZigLive never downloads toolchains at runtime. Releases: <https://ziglang.org/download/>, <https://zigtools.org/zls/releases/0.16.0/> and <https://rustup.rs>. The Rust instrumenter's crates (`syn`, `proc-macro2`, `quote`, `unicode-ident`) are vendored in `rust/instrumenter/vendor/` so builds stay offline.

Pinned application stack: React 19.2.8, Monaco Editor 0.56.0, Monaco Vim 0.4.4, Vite 8.2.2, Fastify 5.12.1, `ws` 8.21.3, Zod 4.4.3 and TypeScript 7.0.2. Exact resolutions are recorded in `pnpm-lock.yaml`.

## Install and verify

```bash
corepack enable
pnpm install
pnpm run doctor
```

`pnpm` 11 reserves `pnpm doctor` for pnpm's own environment doctor, so use the explicit package-script spelling `pnpm run doctor` for the ZigLive doctor.

## Development

```bash
pnpm dev
```

This first builds `runzig-instrument` and the shared protocol, then starts:

- UI: <http://127.0.0.1:5173>
- orchestrator: `127.0.0.1:4317` (proxied by Vite)

Override the server port with `ZIGLIVE_PORT`; update the Vite proxy when using a non-default development port.

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
pnpm --filter @ziglive/server test
pnpm --filter @ziglive/web test
pnpm typecheck
```

## Usage

The UI is a Catppuccin-Mocha workspace of floating cards: file tree, editor and a dockable terminal, with a top bar (tabs, Run, auto, zen) and a status bar (mode chip, run state, timings, cursor).

Every workspace is **multilingual by extension**: the session starts with the entry file of every language whose toolchain is present (`main.zig`, `main.rs`, `main.go`, `main.ts`, `main.py` and their test files), and the file you are editing decides everything — Run (and Auto Run after an edit) executes that file's language pipeline, ZLS and rust-analyzer run side by side routed by extension, and assets like `input.txt` are shared between both. The status bar and terminal prompt reflect the active file's language, and the last language you touched is remembered for the next session. Rust runs use `cargo build`/`cargo run` with structured `--message-format=json` diagnostics, `#[test]` functions in the tests panel, and the same inline probe values and log-source tracing via `rustlive-instrument`.

Keyboard: **Ctrl/Cmd+Enter** run · **Ctrl/Cmd+S** format the document (ZLS / rust-analyzer) and return Vim to Normal mode · **Ctrl/Cmd+B** toggle tree · **Ctrl/Cmd+J** toggle terminal · **Ctrl/Cmd+K** command palette (open, or ⌘↵ open-and-run, or create a file by typing a new name) · **Ctrl/Cmd+.** zen mode. Layout (dock side, tree, zen) persists in the browser.

- Create, open, rename and delete files — and organize them in folders — from the project tree or the palette (type `carpeta/archivo.ext`; the `＋/` button creates an empty folder that materializes with its first file). Folders collapse, and their badge aggregates failing tests. Tabs preserve Monaco models and can be closed with ✕; Zig modules can import one another with relative `@import` paths.
- `test "…"` blocks (Zig), `#[test]` functions (Rust), `func TestXxx` in `*_test.go` (Go, via `go test -json`) `test()`/`it()` in `*.test.ts|js` (node:test, TAP) and `def test_*` in `test_*.py`/`*_test.py` (custom stdlib runner) run automatically after the program: the terminal shows a per-test panel (pass/fail/skip/leak, duration, click to jump), the editor shows an error-lens result at the end of each test line, the tree shows failing counts per file, and the last four runs appear in the history block.
- ZLS diagnostics, completion, hover, definition, formatting, semantic tokens, inlay hints and code actions work across opened `.zig` files when advertised.
- Auto Run debounces edits for 400 ms. **Ctrl/Cmd+Enter** runs immediately; clicking the Run button while it shows “Corriendo” cancels the active run.
- Vim Mode is enabled by default and can be toggled in the navigator. Use `i` to insert, `Esc` for Normal mode and `:w` to run the current source. Native Ctrl/Cmd+A/C/X/V shortcuts and the editor's right-click Copy/Paste menu remain available.
- Auto Inspect adds probes to supported local declarations in every `.zig` module under `generated/`. Click declaration glyphs for manual probes.
- Inline values become crossed-out/stale immediately after an edit. Only matching document-version events can replace them.
- The terminal resets at the start of every run and can dock right or bottom, maximize, or close. Runs of four or more log lines from the same statement and panic traces collapse into expandable ▸ folds. Program output is neutral; compiler/runtime failures are red. Hover output produced by `std.debug.print` or `std.log` to highlight its source line; click to pin the highlight and move the editor there. Repeated loop logs show their execution number, enclosing loop line, and detected loop variable/value. Diagnostics and Runtime retain owner and timing details.

## Workspace

Each browser session gets `/tmp/ziglive/<random-id>/` with a visible multi-file `src/` project, a generated mirror, runtime/source maps, `build.zig`, a local cache and output. Text assets are mirrored so `@embedFile("input.txt")` works; execution uses `src/` as cwd so runtime reads such as `readFileAlloc(..., "input.txt", ...)` work too. Projects are capped at 64 files and 8 MiB. Session IDs and bearer tokens are random; absolute paths and traversal segments are rejected. Workspaces are removed on disconnect/shutdown and abandoned directories older than 24 hours are removed at startup.

## Credits

The Zig mark used for `.zig`/`.zon` file icons comes from [ziglang/logo](https://github.com/ziglang/logo) (CC-BY-SA-4.0, Zig Software Foundation). The vendored Rust crates under `rust/instrumenter/vendor/` keep their original MIT/Apache-2.0 licenses.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocols](docs/protocols.md)
- [Instrumentation](docs/instrumentation.md)
- [Limitations/security](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Implementation decisions](docs/implementation-plan.md)
