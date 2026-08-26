# Protocols

All runtime messages are JSON and versioned at protocol version 1. Shared TypeScript definitions and Zod validation live in `packages/protocol`.

## Session HTTP

`POST /api/sessions` returns a random session ID, a 256-bit bearer token, the real `file://` URI, tool versions and initial source. Origin must exactly match the loopback UI origin.

## Runtime WebSocket

`/ws/runtime?sessionId=…&token=…` accepts:

- `document.update` with a full monotonic snapshot;
- `run.request` and `run.cancel`;
- `settings.update` for Auto Run, Auto Inspect, debounce, timeout and manual IDs.

Server events include `run.state`, `probe.catalog`, `probe_value`, capped output chunks, owner-separated diagnostics, `run.finished` metrics and typed recoverable errors. Output chunks retain the OS stream and carry a `program` or `error` category so normal Zig stderr output is not presented as a failure. Instrumented `std.debug.print` and `std.log` chunks also carry an optional `sourceLocation` with the original line/column and `executionIndex`. When detected, `sourceLocation.loop` contains the enclosing loop line/column plus its variable name and runtime value. Hovering a sourced terminal row temporarily highlights the print and loop lines; clicking pins the highlight and reveals the print line. The browser ignores every event whose `documentVersion` is not active.

## LSP WebSocket

`/ws/lsp` carries one complete JSON-RPC object per WebSocket text message. `LspProxy` reconstructs `Content-Length` frames using UTF-8 byte length. In the reverse direction it accepts fragmented headers/bodies and concatenated frames and emits complete objects.

## Native probe channel

The child inherits fd 1 for stdout, fd 2 for stderr/panics, and fd 3 for NDJSON probe records. Node adds session, run, version, timestamp and execution count. Records are capped at 64 KiB; the run channel is capped at 1 MiB and 10,000 events.
