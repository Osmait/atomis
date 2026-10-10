# Contributing

## What you need

Atomis never downloads a toolchain at runtime, so what is on your `PATH` is
what your sessions can use. `pnpm run doctor` tells you what it found and what
that disables.

Required: Node 22 (23/24 fine for development), pnpm 11 via corepack, Rust
1.85+ (the dependency tree needs Cargo's 2024 edition support), and Zig 0.16.x with ZLS 0.16.x.

Optional, each enabling its language: Go 1.22+ with gopls, Python 3.9+ with
pyright, clang 15+ with clangd, and `typescript-language-server`. A missing one
is not an error — that language shows as degraded and the rest work.

## Getting it running

```bash
corepack enable
pnpm install
pnpm run doctor      # `pnpm doctor` is pnpm's own; the explicit spelling is ours
pnpm dev             # UI on 5173, server on 4317
```

## Before you open a PR

```bash
pnpm typecheck       # also regenerates the wire types from the Rust ones
pnpm lint            # oxlint with any/unknown banned, plus clippy -D warnings
pnpm test            # unit tests across every language's instrumenter
pnpm test:e2e        # Playwright, desktop and touch
```

CI runs all of it for code, app assets, tests, dependencies, and configuration
changes. Pushes and PRs that only change `docs/**`, Markdown files, or `LICENSE`
skip CI. A mixed documentation/code change still runs the full suite.
Docker validation runs for `Dockerfile`, `.dockerignore`, and its own workflow;
Docker and Release also keep their existing manual triggers.

These path-filtered workflows must not become required checks without a
skip-safe gate: [GitHub leaves skipped workflow checks pending](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).

Run `pnpm exec playwright install chromium` once per machine —
the touch projects run Chromium at phone and tablet size rather than WebKit,
because the repo installs one browser on purpose.

## Measuring

Two harnesses, so a claim about performance can be checked rather than
argued:

```bash
node scripts/bench.mjs --out bench/mine.json   # runtime, in a real browser
node scripts/metrics.mjs --out bench/code.json # size and shape of the code
```

`bench.mjs` starts its own server on a spare port with its own preferences —
never point a benchmark at a running instance, because settings live on the
server and sync to every device you own. It reports what a person waits for
(editor ready, a run, a keystroke reaching its inline value), the server's own
breakdown of that time, and what a first visit downloads. `--languages zig,ts`
narrows it while iterating; `--runs N` sets the sample count.

`bench/baseline.json` and `bench/after.json` are the before and after of the
optimisation pass they document.

## Things worth knowing before you change something

**The wire contract is generated.** `packages/protocol/src/generated/` comes
from the Rust types that actually serialize, and `conformance.ts` fails the
build if the hand-written types drift from them. Change the Rust type, run
`pnpm protocol:generate`, and fix what stops compiling.

**A language is one pack.** `apps/server-rs/src/languages/packs.rs` holds one
`LanguagePack` per language — its extensions, toolchain checks, language
server, instrumenter, dependency support and the function that runs a file.
Adding a language is a folder beside it and one entry; nothing dispatches on
`Language` outside that table.

**Settings live on the server.** They are shared by every device that opens
the same instance, so a browser automating against a running server changes
what the developer sees. The e2e suite points at its own preferences and
workspace directories for exactly that reason.

**Tests that cannot fail are not tests.** Where a guard exists to catch a
specific regression, the commit that added it says how it was verified by
reintroducing the bug. Please keep that up.
