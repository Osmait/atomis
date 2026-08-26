# Rewrite del backend en Rust (rama `rust-backend`)

Objetivo: reemplazar `apps/server` (Node/Fastify, ~5.7k líneas TS) por
`apps/server-rs` (axum/tokio) manteniendo **el mismo protocolo WS y HTTP**,
de modo que el frontend no cambie y los 23 e2e de Playwright validen la
paridad. Al final, el sidecar SEA del desktop se sustituye por este binario
(o se embebe como tarea tokio dentro del proceso Tauri).

## Por qué

La latencia de un run la dominan los compiladores nativos — el rewrite no
acelera compilar. Compra: arranque instantáneo, ~15 MB en vez de ~90 MB de
sidecar Node, un solo lenguaje en el desktop, menos RAM.

## Fases

1. **Protocolo** (`src/protocol.rs`) — tipos espejo de `packages/protocol`
   con serde, JSON campo a campo idéntico. Tests de round-trip contra
   fixtures grabadas del server Node.
2. **HTTP + sesiones** — `/api/health`, `/api/doctor`, `POST /api/sessions`
   (origin guard, tokens, scaffold multilingüe copiando templates), gestión
   de workspaces efímeros en `/tmp/ziglive`.
3. **Runtime WS** — `/ws/runtime`: document store versionado, RunScheduler
   (debounce, cancelación), ProcessSupervisor (spawn con límites/timeout,
   fd3 para probes vía pipes), lectores NDJSON (probes/tests) y el parser de
   marcadores `\x1eZIGLIVE_LOG` compartido.
4. **Runners por lenguaje** — portar uno a uno empezando por zig (el e2e de
   zig es el más rico), luego rust/go/ts/py/c/cpp. Los instrumentadores ya
   son binarios/scripts externos: solo cambia quién los orquesta.
5. **LSP proxy** — `/ws/lsp?lang=`: bridge WS↔stdio con framing LSP
   (Content-Length), filtros existentes.
6. **Swap** — apuntar Vite proxy y el sidecar del desktop al binario Rust,
   correr la suite e2e completa, retirar apps/server.

## Reglas

- Cada fase se valida con los e2e existentes apuntando `VITE_PROXY_TARGET`
  al server Rust (paridad observable, no reescritura especulativa).
- Protocolo aditivo: cualquier divergencia JSON es un bug del rewrite.
- El server Node no se toca durante el rewrite (sigue siendo main).
