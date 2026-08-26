# Architecture

ZigLive is a loopback-only local web application. The browser and native runner never share a transport.

```text
React + Monaco
  ├─ /ws/lsp     JSON objects ─ Fastify upgrade ─ LspProxy ─ framed stdio ─ ZLS
  └─ /ws/runtime validated events ─ RunScheduler
                                    ├─ DocumentStore (atomic multi-file src/)
                                    ├─ runzig-instrument (every .zig module)
                                    ├─ zig build instrumented tests
                                    ├─ ProcessSupervisor ─ stdout / stderr / fd 3
                                    └─ ziglive-tests ─ custom runner ─ fd 3 NDJSON
```

## Components

- `SessionManager` creates unguessable workspaces under the OS temporary directory and derives every path internally.
- `DocumentStore` owns the monotonic project snapshot and atomically creates, updates, renames and removes validated paths below `src/`.
- `LspProxy` implements byte-correct LSP framing and owns one restart attempt independently of run state.
- Monaco's stable provider APIs are the LSP client layer. This is the current lightweight alternative to `monaco-languageclient`; providers are registered only for ZLS-advertised capabilities.
- `RunScheduler` is the explicit state machine boundary. A new version clears debounce and aborts the previous pipeline.
- `CompilerRunner` mirrors assets, instruments every Zig module, compiles from generated `main.zig`, executes with `src/` as cwd, maps diagnostics and enriches probe/log events with their source path.
- `TestDiscovery` finds `test` blocks in the visible sources and maps runner-qualified names back to files; `CompilerRunner` generates `test_root.zig`, builds `ziglive-tests` with the custom `runzig_test_runner.zig` (mode `simple`), executes it after the program run and streams per-test results from fd 3 through `TestEventReader`.
- `ProcessSupervisor` starts detached process groups, enforces time/output limits, sends TERM then KILL, and closes stdin.

## Multilingual workspaces

`POST /api/sessions` accepts a `language` (zig, rust or go) which only selects the initial entry file. Language support is declared in `apps/server/src/languages/registry.ts` (mirrored by `apps/web/src/languages.ts`): each pack contributes extensions, an entry file, a scaffold, a runner, an instrumenter path and toolchain checks. Every workspace carries the scaffold of every language whose toolchain is present; entry files are protected. Go sessions compile `go build ./generated` into a single `package main`, run tests with `go test -json ./src` (structured per-test events), and instrument with `golive-instrument` (stdlib `go/parser`, byte-exact offsets). `RunScheduler` holds one runner per language and dispatches by the edited/active file's extension (`run.request` carries an optional `language`; auto-run derives it from the updated path). `/ws/lsp?lang=zig|rust` multiplexes one `LspProxy` per language so ZLS and rust-analyzer serve the same workspace side by side, and `resetGenerated` preserves both language runtimes when either pipeline rebuilds the mirror. The Rust half of the workspace is a two-target cargo package: `ziglive-check` compiles the visible `src/main.rs` (what rust-analyzer and the test build see) and `ziglive-session` compiles the instrumented `generated/` mirror. `RustCompilerRunner` drives the same `RunnerCallbacks` contract: `rustlive-instrument` (a vendored-`syn` binary mirroring the `runzig-instrument` CLI/JSON) splices `ziglive_probe!`/`ziglive_log!` calls, `cargo build --message-format=json --offline` produces structured diagnostics (`CargoDiagnostics`), the binary runs supervised with fd 3 probes, and `cargo test --no-run` plus a supervised libtest run (`--test-threads=1`, parsed by `RustTestOutput`) feeds the shared test events. `RuntimeOutputParser` strips the `\x1eZIGLIVE_LOG` markers per stream for both languages (Rust `println!` marks stdout, `eprintln!`/`dbg!` mark stderr). `LspProxy` spawns `rust-analyzer` instead of ZLS.

The server defaults to `127.0.0.1:4317`; Vite at `127.0.0.1:5173` proxies both same-origin transports in development.
