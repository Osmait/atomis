# Backend rewrite in Rust (branch `rust-backend`, completed)

Goal: replace `apps/server` (Node/Fastify, ~5.7k lines of TS) with
`apps/server-rs` (axum/tokio) keeping **the same WS and HTTP protocol**, so
the frontend does not change and the Playwright e2e suite validates parity.
At the end, the desktop's Node SEA sidecar is replaced by this binary.

## Why

Run latency is dominated by the native compilers — the rewrite does not
make compiles faster. What it buys: instant startup, a ~5 MB sidecar
instead of ~90 MB of Node SEA, a single language in the desktop app, less
RAM.

## Phases (as executed)

1. **Protocol** (`src/protocol.rs`) — serde mirror types of
   `packages/protocol`, field-for-field identical JSON.
2. **HTTP + sessions** — `/api/health`, `/api/doctor`, `POST /api/sessions`
   (origin guard, tokens, multilingual scaffold copied from templates),
   ephemeral workspaces under `/tmp/atomis`.
3. **Runtime WS** — `/ws/runtime`: versioned document store, RunScheduler
   (debounce, cancellation), ProcessSupervisor (spawn with limits/timeout,
   fd 3 probes via pipes), NDJSON readers (probes/tests) and the shared
   `\x1eATOMIS_LOG` marker parser.
4. **Per-language runners** — ported one by one starting with zig (its e2e
   coverage is the richest), then rust/go/ts/py/c/cpp. Instrumenters were
   already external binaries/scripts: only the orchestrator changed.
5. **LSP proxy** — `/ws/lsp?lang=`: WS↔stdio bridge with LSP framing
   (Content-Length) and the existing filters.
6. **Swap** — point the Vite proxy and the desktop sidecar at the Rust
   binary, run the full e2e suite, retire `apps/server`.

## Final state

- All phases complete; the full Playwright suite passes against the Rust
  server, first on a parallel harness (`ATOMIS_PORT`/`ATOMIS_WEB_PORT`/
  `ATOMIS_PROXY`/`ATOMIS_BASE_URL`/`ATOMIS_DEV_ORIGIN`) and then on the
  default stack after the swap.
- The `POST /api/sessions` response is byte-identical to Node's after id
  normalization (including ICU file ordering).
- The desktop sidecar ships the Rust binary (~5 MB); same env vars and the
  same `ATOMIS_LISTENING` announce line.
- **Swap completed**: `apps/server` retired; `pnpm dev`/`start`/`doctor`/
  `test`/`build` target the Rust binary (`--doctor` replaces the tsx
  doctor). Rust unit tests cover `locale_compare`, file URLs and the
  marker parser; protocol parity remains guaranteed by the e2e suite.

## Rules that governed the rewrite

- Every phase was validated by the existing e2e suite pointed at the Rust
  server (observable parity, not speculative rewriting).
- Additive protocol: any JSON divergence is a rewrite bug.
- The Node server stayed untouched until the swap.
