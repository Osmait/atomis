# Hosting on Railway: sizing, cost and monitoring

Atomis is built for one person on their own machine. Hosting it puts a
code-running server on the internet, so read "Before you expose it" in the
README first: the token is the only thing between the URL and a shell.

## Deploying

The repository's `Dockerfile` builds as-is. On the service:

| Setting | Value | Why |
|---|---|---|
| `ATOMIS_TOKEN` | `openssl rand -hex 24` | required: the server refuses `0.0.0.0` without it |
| `ATOMIS_ALLOWED_ORIGINS` | `https://<service>.up.railway.app` | the address people type, or every write gets a 403 |
| `ATOMIS_PORT` | `${{PORT}}` | or leave 4317 and set it as the public networking port |
| Volume | mounted at `/data` | workspaces, preferences and compiler caches survive deploys |
| Healthcheck path | `/api/health` | unauthenticated on purpose, says only that the process is up |
| Serverless | on, for personal use | sleeps after 5-10 minutes without outbound traffic |

Resource knobs, all optional:

| Variable | Default | Effect |
|---|---|---|
| `ATOMIS_LSP_IDLE_SECS` | `600` | stop a language server its editor has not used for this long; the next edit starts a new one. `0` keeps them while the tab is open |
| `ATOMIS_MAX_CONCURRENT_RUNS` | unlimited | a hard ceiling on runs at once; the rest queue. Measured on 2 vCPU it raised the median run (cheap runs wait behind Zig builds), so set it only to bound memory on a very small plan |
| `ATOMIS_GOPLS_MEMLIMIT` | `128MiB` | gopls's soft memory limit (`GOMEMLIMIT`); `off` leaves Go's default |
| `ATOMIS_ZIG_INCREMENTAL` | on | `0` builds Zig with `zig build` every run instead of keeping incremental compile servers (~120 MB each, two per Zig session, stopped after 10 idle minutes) |

The image runs as uid 10001, and Railway mounts volumes owned by root. If the
first deploy logs a permission error under `/data`, set `RAILWAY_RUN_UID=0`.

Railway's kernel and seccomp profile decide whether the Landlock sandbox
works there; `atomis-server --doctor` in the service shell says which. Without
it, code runs unconfined inside the container, which is the boundary.

## What it costs

`scripts/loadtest.mjs` measures the server the way Railway bills it: inside
its own cgroup, CPU-seconds and resident memory of the whole process tree,
compilers and language servers included. `scripts/load-report.mjs` turns the
results into a page with an estimator.

```bash
pnpm build
node scripts/loadtest.mjs --lsp --stages 1,2,4,8,16 --stage-seconds 60 \
  --out bench/load-unbounded.json
node scripts/loadtest.mjs --lsp --stages 1,2,4,8,16 --stage-seconds 60 \
  --cpus 2 --memory 2G --port 4473 --out bench/load-2cpu-2g.json
node scripts/load-report.mjs            # writes bench/load-report.html
```

It needs Linux with cgroup v2 and `systemd-run --user` (any systemd
desktop). It starts its own server with its own data directory and never
touches the running instance. To compare after a change, copy the earlier
pair of JSON files into a directory and pass it as `--before <dir>`.

What dominates the bill, from the measurements:

- **Language servers**, while anyone is editing. rust-analyzer holds about
  half a GB, tsserver about 380 MB, the others under 150 MB; they stop ten
  minutes after their editor goes quiet.
- **Runs**, in CPU-seconds each: a few hundredths for Zig (incremental) and
  Python, a few tenths for TypeScript, Go, Rust and C/C++. A Zig session also
  holds its compile servers, ~120 MB each, while it is in use.
- **The idle server** is a few MB and close to zero CPU: with Serverless on,
  a personal instance spends most of the month asleep.

## Monitoring

Railway's service metrics show CPU, memory and network from outside. The
server's own view is at `/api/metrics`, in the Prometheus text format, behind
the same token as everything else:

```bash
curl -H "Authorization: Bearer $ATOMIS_TOKEN" https://<service>.up.railway.app/api/metrics
```

| Metric | Type | Meaning |
|---|---|---|
| `atomis_runs_total{language,outcome}` | counter | finished runs: succeeded, compile_error, runtime_error, timed_out, cancelled |
| `atomis_run_duration_seconds{language}` | histogram | request-to-result wall time |
| `atomis_run_phase_seconds_total{language,phase}` | counter | instrument / compile / execute time as the runner reports it |
| `atomis_runs_in_flight` | gauge | runs compiling or executing right now |
| `atomis_runs_queued` | gauge | runs waiting for a slot, only with `ATOMIS_MAX_CONCURRENT_RUNS` set |
| `atomis_sessions` | gauge | live sessions, including those in their reconnect grace |
| `atomis_lsp_servers{language}` | gauge | language server processes alive |
| `atomis_zig_compile_servers` | gauge | Zig compilers kept running for incremental builds |
| `atomis_cgroup_cpu_seconds_total` | counter | the container's CPU, as billed |
| `atomis_cgroup_memory_bytes` | gauge | the container's memory, as billed |
| `atomis_process_cpu_seconds_total` | counter | the server plus the children it has reaped |
| `atomis_process_resident_bytes` | gauge | the server process alone |

Any Prometheus-compatible scraper that can send a bearer token works, for
example Grafana Alloy pushing to Grafana Cloud's free tier. A scraper is a
second service and keeps the first one awake, so with Serverless on, scrape
from outside Railway or not at all: `atomis_cgroup_*` divided by the hours
the service was awake is the same number the bill uses.

A few useful queries:

```promql
# CPU-seconds per run, the cost model's main input
increase(atomis_cgroup_cpu_seconds_total[1h]) / scalar(sum(increase(atomis_runs_total[1h])))

# p95 run latency
histogram_quantile(0.95, sum by (le, language) (rate(atomis_run_duration_seconds_bucket[5m])))

# billed memory, next to the language servers that explain most of it
atomis_cgroup_memory_bytes
sum by (language) (atomis_lsp_servers)
```

## Profiling

`perf` flame graphs of the server and every process it starts, under the
same load test. Needs `perf` and a user-space profiling permission
(`kernel.perf_event_paranoid` ≤ 2, the default on most distributions).

```bash
# A server with symbols and frame pointers, beside the normal build.
CARGO_TARGET_DIR=apps/server-rs/target-prof CARGO_PROFILE_RELEASE_STRIP=false \
  CARGO_PROFILE_RELEASE_DEBUG=line-tables-only RUSTFLAGS="-C force-frame-pointers=yes" \
  cargo build --release --manifest-path apps/server-rs/Cargo.toml

node scripts/loadtest.mjs --server apps/server-rs/target-prof/release/atomis-server \
  --perf /tmp/atomis.data --perf-period-us 1000 --stages 4,8 --stage-seconds 45
perf script -i /tmp/atomis.data -F comm,pid,tid,time,event,ip,sym,dso > /tmp/script.txt
python3 scripts/fold-perf.py /tmp/script.txt /tmp/steady.folded --from 0.28 --to 0.95
python3 scripts/flame-report.py /tmp/flame.html "Steady load=/tmp/steady.folded"
```

Samples are taken per millisecond of each thread's CPU, not at a
frequency: perf's frequency mode starts every new thread at its shortest
period, and the short-lived, many-threaded processes here (a linker with a
thread per core, alive 10 ms) then outnumber everything that really used
the CPU. Samples taken inside the kernel have no user stack; `fold-perf.py`
keeps them as `[kernel]` under their process instead of dropping them. Pick
`--from/--to` from the load test's timeseries phases to separate the cold
start from steady load.

## Timelines

Where a run's wall-clock time goes, waiting included — what a CPU profile
cannot show. `ATOMIS_TRACE=<file>` makes the server write every span it
records (each run, its phases, every child process and its fork+exec, the
instrumenter workers, Zig's compile servers, the result's send) in the
Chrome Trace format; it costs nothing when unset.

```bash
node scripts/loadtest.mjs --trace /tmp/trace.json --stages 1 --stage-seconds 3 --runs 15
python3 scripts/trace-report.py /tmp/trace.json /tmp/timelines.html
```

The load test adds the client's side of each run on the same clock, and
the report splits every run end to end into segments (to server, queued,
each phase's processes and server time, drain, send, to client), prints the
medians per language and writes a waterfall page. `/tmp/trace.json.perfetto.json`
opens in https://ui.perfetto.dev with one row per run.
