# Protocols

All runtime messages are JSON and versioned at protocol version 1. Shared TypeScript definitions and Zod validation live in `packages/protocol`.

## Session HTTP

`POST /api/sessions` accepts an optional `{ "language": "zig" | "rust" }` body (default `zig`, selecting the initial entry file of the bilingual workspace) and returns a random session ID, a 256-bit bearer token, the session language, tool versions (including `rustc`/`cargo`/`rust-analyzer` when present) and the initial project file catalog with real `file://` URIs. Origin must exactly match the loopback UI origin.

## Runtime WebSocket

`/ws/runtime?sessionId=…&token=…` accepts:

- `document.update` for a versioned project-relative file;
- `file.create`, `file.rename` and `file.delete` for validated paths below `src/`;
- `run.request` (optionally carrying the `language` to execute; auto-run derives it from the edited file's extension) and `run.cancel`;
- `settings.update` for Auto Run, Auto Inspect, debounce, timeout and manual IDs.

Server events include authoritative `project.files` catalogs, `run.state`, `probe.catalog`, `probe_value`, `test.catalog`, `test.result`, `test.summary`, capped output chunks, owner-separated diagnostics, `run.finished` metrics and typed recoverable errors. Output chunks retain the OS stream and carry a `program` or `error` category so normal Zig stderr output is not presented as a failure. Instrumented `std.debug.print` and `std.log` chunks also carry an optional `sourceLocation` with the original line/column and `executionIndex`. When detected, `sourceLocation.loop` contains the enclosing loop line/column plus its variable name and runtime value. Hovering a sourced terminal row temporarily highlights the print and loop lines; clicking pins the highlight and reveals the print line. The browser ignores every event whose `documentVersion` is not active.

## LSP WebSocket

`/ws/lsp` carries one complete JSON-RPC object per WebSocket text message. `LspProxy` reconstructs `Content-Length` frames using UTF-8 byte length. In the reverse direction it accepts fragmented headers/bodies and concatenated frames and emits complete objects.

## Test events

`test.catalog` lists every `test "…"` and `test decl {` block discovered by regex over the visible sources, with a stable `testId` (`path:line`) and 1-based positions. During the `testing` run state each executed test produces `test.result` with `status` (`passed`, `failed`, `skipped`, `leaked`, `timed_out`), its duration in milliseconds and, for failures, a bounded `message` taken from the runner error name and correlated stderr. `test.summary` closes the phase with aggregate counts and the total duration. Results reference catalog entries by `testId` when the runner-qualified name (`src.file.test.title`) can be mapped back; unmatched results keep only the raw name.

## Native probe channel

The child inherits fd 1 for stdout, fd 2 for stderr/panics, and fd 3 for NDJSON probe records. Node adds session, run, version, timestamp and execution count. Records are capped at 64 KiB; the run channel is capped at 1 MiB and 10,000 events. The test binary uses the same fd 3 channel for its `test_start`/`test_result`/`test_summary` NDJSON records.
