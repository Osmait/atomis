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
| `ATOMIS_MAX_CONCURRENT_RUNS` | CPUs available | runs beyond this wait in a queue instead of sharing the CPUs and the memory limit |
| `ATOMIS_GOPLS_MEMLIMIT` | `128MiB` | gopls's soft memory limit (`GOMEMLIMIT`); `off` leaves Go's default |

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
- **Runs**, in CPU-seconds each. Zig is the most expensive per run by an
  order of magnitude; Python the cheapest.
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
| `atomis_runs_queued` | gauge | runs waiting for a slot; persistently above zero means the service needs more vCPU |
| `atomis_sessions` | gauge | live sessions, including those in their reconnect grace |
| `atomis_lsp_servers{language}` | gauge | language server processes alive |
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
