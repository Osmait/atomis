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

Pinned application stack: React 19.2.8, Monaco Editor 0.56.0, Vite 8.2.2, Fastify 5.12.1, `ws` 8.21.3, Zod 4.4.3 and TypeScript 7.0.2. Exact resolutions are recorded in `pnpm-lock.yaml`.

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

- Edit Zig; ZLS diagnostics, completion, hover, definition, formatting, semantic tokens, inlay hints and code actions are enabled only when advertised.
- Auto Run debounces edits for 400 ms. **Ctrl/Cmd+Enter** runs immediately; **Escape** or Stop cancels.
- Auto Inspect adds probes to supported local declarations in `generated/main.zig`. Click declaration glyphs for manual probes.
- Inline values become crossed-out/stale immediately after an edit. Only matching document-version events can replace them.
- Output, Problems and Runtime preserve separate stdout, stderr/panics, diagnostic owners and run metrics.

## Workspace

Each tab gets `/tmp/ziglive/<random-id>/` with visible `src/main.zig`, generated source/runtime/source map, `build.zig`, a local cache and output. Session IDs and bearer tokens are random; arbitrary client paths are rejected. Workspaces are removed on disconnect/shutdown and abandoned directories older than 24 hours are removed at startup.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocols](docs/protocols.md)
- [Instrumentation](docs/instrumentation.md)
- [Limitations/security](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Implementation decisions](docs/implementation-plan.md)
