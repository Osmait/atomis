# ZigLive implementation plan

## Environment baseline

- Zig: 0.16.x, verified through `zig version`.
- ZLS: 0.16.x, launched per session over stdio.
- Node: maintained releases from 22 through 24 are accepted by the developer tooling; Node 22 is the production baseline.
- Host: Linux and macOS only.

## Concrete decisions

1. A Fastify process owns session workspaces, ZLS children, compiler/runtime children, tokens and both WebSockets.
2. Vite proxies `/api` and `/ws` in development. Production assets are served by Fastify. Both modes bind only to `127.0.0.1`.
3. Monaco's stable provider APIs form the LSP client. This is the allowed current alternative to `monaco-languageclient`; it avoids the latter's tightly coupled VS Code service overrides while retaining completion, hover, definition, formatting, semantic tokens, inlay hints and code actions.
4. Runtime messages are validated with Zod from a shared protocol package. LSP and run transports remain separate.
5. Every run is tied to a full immutable document snapshot. New snapshots abort older debounce, instrument, compile and execute stages.
6. `runzig-instrument` is the only component that interprets Zig syntax. It uses `std.zig.Ast`; the server never discovers declarations with regular expressions.
7. Generated source retains every original byte and inserts probes after declaration semicolons in descending byte-offset order. No formatter touches generated source.
8. Probe events use inherited fd 3 and NDJSON. stdout and stderr are independent capped pipes.
9. Native execution is explicitly not a sandbox. Auto Run, timeout, cancellation and output caps are the MVP controls.

## Vertical phases and verification

- Environment/doctor and real fd-3/ZLS spikes become doctor checks and integration tests.
- Session + editor shell.
- LSP framing/proxy and Monaco providers.
- Versioned scheduler/process supervision.
- AST instrumenter/runtime serializer.
- Inline decorations/manual probes/precise diagnostic filtering.
- Security, process cleanup, real Playwright flows, production build and documentation.
