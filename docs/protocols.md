# Protocols

The shapes the server sends are **generated** from the Rust types that send them: `pnpm protocol:generate` writes `packages/protocol/src/generated/`, and `packages/protocol/src/conformance.ts` asserts at compile time that the hand-written types in `index.ts` still say the same thing. Both sides were written by hand until then, and adding a field to one and forgetting the other failed at runtime or not at all. Generation runs as part of `pnpm typecheck` and `pnpm build`, so a stale binding is a build error rather than a surprise.

Writing the check found four places where the two had already drifted: `manifest`/`inputHint` were sent as `null` while the client expected them absent; `rustcVersion`, `sandbox` and four other fields were declared optional but always sent; and `kind`, `protocolVersion` and `sandboxSupport` were plain strings on the wire while the client narrowed them to literals. Each is now stated once, on the Rust side.

All runtime messages are JSON and versioned at protocol version 1. Shared TypeScript definitions and Zod validation live in `packages/protocol`.

## Session HTTP

`POST /api/sessions` accepts an optional `{ "language": "zig" | "rust" }` body (default `zig`, selecting the initial entry file of the bilingual workspace) and returns a random session ID, a 256-bit bearer token, the session language, tool versions (including `rustc`/`cargo`/`rust-analyzer` when present) and the initial project file catalog with real `file://` URIs. Origin must exactly match the loopback UI origin, or one of the origins listed in `ATOMIS_ALLOWED_ORIGINS` (comma-separated, blank entries ignored) — the reverse-proxy escape hatch used by `pnpm start:remote`, and the only origin override honoured under `NODE_ENV=production`. `ATOMIS_DEV_ORIGIN` and the Vite dev origin are refused there.

## Access token

`ATOMIS_TOKEN`, when set, is required by every `/api/*` route and both WebSocket upgrades, on top of the Origin guard: `Authorization: Bearer <token>` for HTTP, `?t=<token>` for the sockets, which cannot carry custom headers. Unset — the default, and how a loopback install runs — nothing changes.

The Origin guard alone is not authentication. It proves a request came from a browser on the expected page; it cannot tell a browser from a `curl` that sets the same header, and the expected Origin is the machine's own name rather than a secret. That is only a distinction worth drawing once something other than your own browser can reach the port.

## Preferences HTTP

`GET /api/preferences` returns `{ "preferences": { key: string } }` — the UI settings shared by every device that opens this server, stored as one JSON object at `$XDG_DATA_HOME/atomis/preferences.json` (overridable with `ATOMIS_PREFERENCES`). A missing or corrupt file reads as empty rather than failing.

`PUT /api/preferences` takes `{ "preferences": { key: string | null } }` and **merges** it key by key, `null` deleting, returning the stored result. Merging rather than replacing is what lets two devices change different settings concurrently without either clobbering the other. Keys are bounded (64 keys, 128 bytes per key, 16 KiB per value) and writes are serialized and committed by rename. Both verbs are Origin-guarded like the rest; the GET accepts a missing `Origin` the way the other read endpoints do.

A successful `PUT` is fanned out to every open runtime socket as a `preferences.changed` event carrying the same patch, so a setting changed on one device lands on the others without a reload. The client applies an incoming change without echoing it back — and drops keys whose value it already holds, which absorbs the echo of its own write.

The client keeps only device-shaped state in `localStorage` (panel layout, active workspace, last entry source); everything the settings dialog holds is synced.

## Runtime WebSocket

`/ws/runtime?sessionId=…&token=…` accepts:

- `document.update` for a versioned project-relative file;
- `file.create`, `file.rename` and `file.delete` for validated paths below `src/`;
- `run.request` (optionally carrying the `language` to execute; auto-run derives it from the edited file's extension) and `run.cancel`;
- `settings.update` for Auto Run, Auto Inspect, debounce, timeout and manual IDs.

Server events include authoritative `project.files` catalogs, `run.state`, `probe.catalog`, `probe_value`, `test.catalog`, `test.result`, `test.summary`, capped output chunks, owner-separated diagnostics, `run.finished` metrics and typed recoverable errors. `probe_value` events optionally carry low-level layout metadata — `bits`, `sizeBytes`, `alignBytes` and (Zig structs) `fields` with per-field name/type/offset/size/preview — emitted by the Zig (`@bitSizeOf`/`@sizeOf`/`@alignOf`/`@offsetOf`), Rust (`size_of_val`/`align_of_val`), Go (`reflect.Type.Size/Align`) and C/C++ (`sizeof`/`_Alignof` captured at the probe site before `_Generic` widening) runtimes; the editor's peek panel and the dec/hex/bin/oct/chr value formatter are built on them. Output chunks retain the OS stream and carry a `program` or `error` category so normal Zig stderr output is not presented as a failure. Instrumented `std.debug.print` and `std.log` chunks also carry an optional `sourceLocation` with the original line/column and `executionIndex`. When detected, `sourceLocation.loop` contains the enclosing loop line/column plus its variable name and runtime value. Hovering a sourced terminal row temporarily highlights the print and loop lines; clicking pins the highlight and reveals the print line. The browser ignores every event whose `documentVersion` is not active.

## LSP WebSocket

`/ws/lsp` carries one complete JSON-RPC object per WebSocket text message. `LspProxy` reconstructs `Content-Length` frames using UTF-8 byte length. In the reverse direction it accepts fragmented headers/bodies and concatenated frames and emits complete objects.

## Test events

`test.catalog` lists every `test "…"` and `test decl {` block discovered by regex over the visible sources, with a stable `testId` (`path:line`) and 1-based positions. During the `testing` run state each executed test produces `test.result` with `status` (`passed`, `failed`, `skipped`, `leaked`, `timed_out`), its duration in milliseconds and, for failures, a bounded `message` taken from the runner error name and correlated stderr. `test.summary` closes the phase with aggregate counts and the total duration. Results reference catalog entries by `testId` when the runner-qualified name (`src.file.test.title`) can be mapped back; unmatched results keep only the raw name.

## Native probe channel

The child inherits fd 1 for stdout, fd 2 for stderr/panics, and fd 3 for NDJSON probe records. Node adds session, run, version, timestamp and execution count. Records are capped at 64 KiB; the run channel is capped at 1 MiB and 10,000 events. The test binary uses the same fd 3 channel for its `test_start`/`test_result`/`test_summary` NDJSON records.
