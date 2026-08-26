# Architecture

ZigLive is a loopback-only local web application. The browser and native runner never share a transport.

```text
React + Monaco
  ├─ /ws/lsp     JSON objects ─ Fastify upgrade ─ LspProxy ─ framed stdio ─ ZLS
  └─ /ws/runtime validated events ─ RunScheduler
                                    ├─ DocumentStore (atomic multi-file src/)
                                    ├─ runzig-instrument (every .zig module)
                                    ├─ zig build instrumented
                                    └─ ProcessSupervisor ─ stdout / stderr / fd 3
```

## Components

- `SessionManager` creates unguessable workspaces under the OS temporary directory and derives every path internally.
- `DocumentStore` owns the monotonic project snapshot and atomically creates, updates, renames and removes validated paths below `src/`.
- `LspProxy` implements byte-correct LSP framing and owns one restart attempt independently of run state.
- Monaco's stable provider APIs are the LSP client layer. This is the current lightweight alternative to `monaco-languageclient`; providers are registered only for ZLS-advertised capabilities.
- `RunScheduler` is the explicit state machine boundary. A new version clears debounce and aborts the previous pipeline.
- `CompilerRunner` mirrors assets, instruments every Zig module, compiles from generated `main.zig`, executes with `src/` as cwd, maps diagnostics and enriches probe/log events with their source path.
- `ProcessSupervisor` starts detached process groups, enforces time/output limits, sends TERM then KILL, and closes stdin.

The server defaults to `127.0.0.1:4317`; Vite at `127.0.0.1:5173` proxies both same-origin transports in development.
