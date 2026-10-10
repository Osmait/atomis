# Demos

Example programs the app offers in its demo gallery (tree ⋯ menu → **Open a
demo…**, or the command palette). A demo opens in a new scratch session, so
trying one never touches a workspace.

Each folder is one idea, written once per language as that language's entry
file (`main.zig`, `main.rs`, `main.go`, `main.ts`, `main.py`, `main.c`,
`main.cpp`). They are ordinary source files: the web app bundles them
verbatim (`apps/web/src/features/demos/catalog.ts`), and
`tests/e2e/demos.spec.ts` runs every one of them through the real toolchains.

| Demo | What it shows |
|---|---|
| `repl/` | A calculator REPL reading stdin line by line. Opens with Run set to **Typed in the terminal**; Auto Run plays a sample session from the Input text. |
| `redis/` | A mini Redis: `SET` `GET` `DEL` `EXISTS` `INCR` `KEYS` `DBSIZE` `FLUSHALL` over a redis-cli style REPL. Every write is appended to `../redis.aof` (beside `src/`, so not a project file); the next run replays it into memory and compacts it. Each Auto Run bumps `visits`, so persistence shows on every edit. |
| `rest/` | A todo-list REST API on the standard library alone: `GET /health`, `GET /todos`, `POST /todos`, `GET`/`PATCH`/`DELETE /todos/{id}`. Each version keeps its routes in a table, one per line, which is both what a framework's router does for you and what lets the HTTP view list them. Opens with **Run as a server** on, in the HTTP view. |
| `rest-express/` `rest-fastapi/` `rest-gin/` `rest-axum/` | The same API on Express (TS), FastAPI (Python), gin (Go) and axum (Rust): one gallery entry, **REST API on a framework**, with the framework as the variant. Each folder's `dependencies.json` is what the session installs when the demo opens; the catalog and the e2e suite both read it. |

Every REST version answers the same 15 requests the same way:
`rest/contract.json`. `node scripts/rest-check.mjs <atomis-url> demos/rest py`
(plus the dependencies, comma separated, for a framework version) runs one
against a live Atomis — the quick loop while writing one — and
`tests/e2e/demos.spec.ts` runs all eleven.

## Adding a demo

1. Add a folder with one entry file per language you have a take in. Keep
   the behaviour identical across languages — the gallery presents them as
   the same program.
2. Register it in `DEMO_KINDS` in `catalog.ts`: a title, a one-line summary,
   the sources, and optionally the Input text it opens with and where Run
   reads stdin from.
3. Give it a spec in `tests/e2e/demos.spec.ts`: `runEach` runs the program
   once per input in the same session, so a demo that keeps state on disk
   can be checked across runs, as the mini Redis is.

Programs that print a prompt without a newline should flush it (C `fflush`,
C++ `std::flush`, Rust `io::stdout().flush()`): stdout is a pipe here, not
a terminal.

Version pins in `dependencies.json` follow what the session templates allow:
gin 1.10 because newer releases need a newer Go than the image's 1.22, and
FastAPI 0.128 / uvicorn 0.39 because the Python template declares
`requires-python >= 3.9`, which later releases dropped.

Two things the instrumentation asks of a demo: in Rust every value bound by
a `let` needs `Debug` (derive it), and C is compiled as strict `-std=c17`
with Atomis's header included first, so a `#define _POSIX_C_SOURCE` comes
too late — use what plain C17 exposes (`inet_pton`, not `getaddrinfo`).

A demo that writes files should write beside `src/` (`../name`), as the mini
Redis does: the program runs with `src/` as its working directory, and what
it leaves in `src/` would show up among the project's files.
