# ZigLive

A loopback-only Zig 0.16 playground inspired by RunJS: Monaco + real ZLS language features, cancellable native compilation/execution, and inline local values produced by AST instrumentation without changing visible code.

> **El código se ejecuta localmente con tus permisos.** ZigLive is not a security sandbox. Pause Auto Run before pasting untrusted code.

## Requirements

- Linux or macOS
- Node.js 22 (23/24 accepted for development)
- Zig 0.16.x on `PATH`
- ZLS 0.16.x on `PATH`
- Corepack/pnpm 11.24.0

ZigLive never downloads Zig or ZLS. Releases: <https://ziglang.org/download/> and <https://zigtools.org/zls/releases/0.16.0/>.

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

- Create, open, rename and delete files from the project tree. Tabs preserve Monaco models, and Zig modules can import one another with relative `@import` paths.
- ZLS diagnostics, completion, hover, definition, formatting, semantic tokens, inlay hints and code actions work across opened `.zig` files when advertised.
- Auto Run debounces edits for 400 ms. **Ctrl/Cmd+Enter** runs immediately; Stop cancels the active run.
- Vim Mode is enabled by default and can be toggled in the navigator. Use `i` to insert, `Esc` for Normal mode and `:w` to run the current source. Native Ctrl/Cmd+A/C/X/V shortcuts and the editor's right-click Copy/Paste menu remain available.
- Auto Inspect adds probes to supported local declarations in every `.zig` module under `generated/`. Click declaration glyphs for manual probes.
- Inline values become crossed-out/stale immediately after an edit. Only matching document-version events can replace them.
- The terminal resets at the start of every run. Program output is neutral; compiler/runtime failures are red. Hover output produced by `std.debug.print` or `std.log` to highlight its source line; click to pin the highlight and move the editor there. Repeated loop logs show their execution number, enclosing loop line, and detected loop variable/value. Diagnostics and Runtime retain owner and timing details.

## Workspace

Each browser session gets `/tmp/ziglive/<random-id>/` with a visible multi-file `src/` project, a generated mirror, runtime/source maps, `build.zig`, a local cache and output. Text assets are mirrored so `@embedFile("input.txt")` works; execution uses `src/` as cwd so runtime reads such as `readFileAlloc(..., "input.txt", ...)` work too. Projects are capped at 64 files and 8 MiB. Session IDs and bearer tokens are random; absolute paths and traversal segments are rejected. Workspaces are removed on disconnect/shutdown and abandoned directories older than 24 hours are removed at startup.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocols](docs/protocols.md)
- [Instrumentation](docs/instrumentation.md)
- [Limitations/security](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Implementation decisions](docs/implementation-plan.md)
