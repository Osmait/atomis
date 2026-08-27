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
   de workspaces efímeros en `/tmp/atomis`.
3. **Runtime WS** — `/ws/runtime`: document store versionado, RunScheduler
   (debounce, cancelación), ProcessSupervisor (spawn con límites/timeout,
   fd3 para probes vía pipes), lectores NDJSON (probes/tests) y el parser de
   marcadores `\x1eATOMIS_LOG` compartido.
4. **Runners por lenguaje** — portar uno a uno empezando por zig (el e2e de
   zig es el más rico), luego rust/go/ts/py/c/cpp. Los instrumentadores ya
   son binarios/scripts externos: solo cambia quién los orquesta.
5. **LSP proxy** — `/ws/lsp?lang=`: bridge WS↔stdio con framing LSP
   (Content-Length), filtros existentes.
6. **Swap** — apuntar Vite proxy y el sidecar del desktop al binario Rust,
   correr la suite e2e completa, retirar apps/server.

## Estado (2026-08-26)

- Fases 1–5 completas: protocolo, sesiones/HTTP, runtime WS (document
  store, scheduler, supervisor con fd 3, lectores NDJSON, parser de
  marcadores), los 7 runners y el proxy LSP.
- **La suite Playwright completa (23/23) pasa contra el server Rust**
  (harness: `ATOMIS_PORT=4319 cargo run` + `ATOMIS_WEB_PORT=5175
  ATOMIS_PROXY=http://127.0.0.1:4319 vite` + `ATOMIS_BASE_URL` en
  Playwright; el server acepta ese origen vía `ATOMIS_DEV_ORIGIN`).
- La respuesta de `POST /api/sessions` es byte-idéntica a la de Node tras
  normalizar ids (incluido el orden ICU de archivos).
- El sidecar del desktop ya usa el binario Rust (5 MB, antes ~90 MB de
  Node SEA); mismos env vars y línea `ATOMIS_LISTENING`.
- `pnpm dev:rs` levanta cargo + vite para desarrollo contra Rust.
- **Swap completado**: `apps/server` retirado; `pnpm dev`/`start`/
  `doctor`/`test`/`build` apuntan al binario Rust (`--doctor` reemplaza
  al doctor de tsx). Unit tests Rust para locale_compare, file URLs y el
  parser de marcadores; la paridad de protocolo la sigue garantizando la
  suite e2e completa.

## Reglas

- Cada fase se valida con los e2e existentes apuntando `VITE_PROXY_TARGET`
  al server Rust (paridad observable, no reescritura especulativa).
- Protocolo aditivo: cualquier divergencia JSON es un bug del rewrite.
- El server Node no se toca durante el rewrite (sigue siendo main).
