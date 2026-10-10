#!/usr/bin/env python3
"""Where each run's wall-clock time goes, from an ATOMIS_TRACE timeline.

    node scripts/loadtest.mjs --trace /tmp/trace.json ...
    python3 scripts/trace-report.py /tmp/trace.json [/tmp/trace.html]

Joins the server's spans with the client's own record of each run (written
by loadtest.mjs as <trace>.client.json, same clock) and splits every run,
end to end, into consecutive segments:

  to server     request sent → run span starts (socket, parsing, dispatch)
  queued        waiting for a run slot
  <phase>       each state the runner reports: Instrumenting, Compiling…,
                split into time inside child processes / workers / compile
                servers and the server's own time between them
  drain         the runner returned → its last events were forwarded
  to send       run span over → result handed to the socket
  to client     result written → the client has it

Prints the median of each segment per language and, with an output path,
writes a page with the medians and one representative run per language as
a waterfall. Also writes <trace>.perfetto.json: the server trace with the
client's spans added, for https://ui.perfetto.dev.
"""

import collections
import json
import statistics
import sys
from pathlib import Path

CHILD = ("process", "worker", "zig compile server")


def load_server(path: Path) -> list[dict]:
    text = path.read_text().rstrip().rstrip(",")
    if not text.endswith("]"):
        text += "]"
    return json.loads(text)


def runs_from(events: list[dict]) -> dict[str, dict]:
    rows = {e["tid"]: e["args"]["name"] for e in events if e.get("ph") == "M"}
    by_row = collections.defaultdict(list)
    for event in events:
        if event.get("ph") == "X":
            by_row[event["tid"]].append(event)
    runs = {}
    for tid, spans in by_row.items():
        name = rows.get(tid, "")
        if not name.startswith("run "):
            continue
        run = next((s for s in spans if s["name"] == "run"), None)
        if run:
            runs[name[4:]] = {"run": run, "spans": spans}
    return runs


def covered(intervals: list[tuple[int, int]], lo: int, hi: int) -> int:
    """Microseconds of [lo, hi) covered by the union of intervals."""
    clipped = sorted((max(a, lo), min(b, hi)) for a, b in intervals if b > lo and a < hi)
    total, end = 0, lo
    for a, b in clipped:
        a = max(a, end)
        if b > a:
            total += b - a
            end = b
    return total


def segments(entry: dict, client: dict) -> tuple[list[tuple[str, float]], dict]:
    run, spans = entry["run"], entry["spans"]
    start, end = run["ts"], run["ts"] + run["dur"]
    children = [(s["ts"], s["ts"] + s["dur"]) for s in spans if s["name"].startswith(CHILD)]
    out = [("to server", start - client["sent"])]
    queued = next((s for s in spans if s["name"] == "queued"), None)
    if queued:
        out.append(("queued", queued["dur"]))
    phases = sorted((s for s in spans if s["name"].startswith("phase ")), key=lambda s: s["ts"])
    runner = next((s for s in spans if s["name"] == "runner"), None)
    runner_end = runner["ts"] + runner["dur"] if runner else end
    for index, phase in enumerate(phases):
        # A phase lasts until the next one starts, or the runner returns.
        lo = phase["ts"]
        hi = phases[index + 1]["ts"] if index + 1 < len(phases) else runner_end
        name = phase["name"][6:]
        inside = covered(children, lo, hi)
        out.append((f"{name}: processes", inside))
        out.append((f"{name}: server", max(0, hi - lo - inside)))
    drain = next((s for s in spans if s["name"] == "drain events"), None)
    if drain:
        out.append(("drain", drain["dur"]))
    send = next((s for s in spans if s["name"] == "send result"), None)
    if send:
        out.append(("to send", max(0, send["ts"] - end)))
        out.append(("send", send["dur"]))
        out.append(("to client", client["received"] - (send["ts"] + send["dur"])))
    else:
        out.append(("to client", client["received"] - end))
    total = client["received"] - client["sent"]
    return out, {"total": total, "language": client["language"], "start": client["sent"]}


def main() -> None:
    trace = Path(sys.argv[1])
    html = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    events = load_server(trace)
    clients = {c["run"]: c for c in json.loads(Path(f"{trace}.client.json").read_text())}
    runs = runs_from(events)

    per_language = collections.defaultdict(list)
    for run_id, entry in runs.items():
        client = clients.get(run_id)
        if not client:
            continue
        parts, meta = segments(entry, client)
        per_language[meta["language"]].append((parts, meta, run_id))

    summary = {}
    for language, items in sorted(per_language.items()):
        names = []
        for parts, _, _ in items:
            for name, _ in parts:
                if name not in names:
                    names.append(name)
        medians = []
        for name in names:
            values = [dict(parts).get(name, 0) for parts, _, _ in items]
            medians.append((name, statistics.median(values) / 1000))
        total = statistics.median(meta["total"] for _, meta, _ in items) / 1000
        # The run closest to the median total, drawn as a waterfall.
        representative = min(items, key=lambda item: abs(item[1]["total"] / 1000 - total))
        summary[language] = {"runs": len(items), "total": total, "segments": medians, "example": representative[2]}
        print(f"\n{language}  ({len(items)} runs, median {total:.1f} ms end to end)")
        for name, ms in medians:
            if ms >= 0.05:
                print(f"  {ms:7.1f} ms  {name}")

    # A Perfetto file with the client's view on each run's row.
    rows = {e["args"]["name"]: e["tid"] for e in events if e.get("ph") == "M"}
    merged = list(events)
    for run_id, client in clients.items():
        tid = rows.get(f"run {run_id}")
        if tid is not None:
            merged.append({"ph": "X", "pid": 1, "tid": tid, "ts": client["sent"],
                           "dur": client["received"] - client["sent"], "name": "client: request → result",
                           "args": {"language": client["language"]}})
    Path(f"{trace}.perfetto.json").write_text(json.dumps(merged))

    if html:
        examples = {}
        for language, info in summary.items():
            entry = runs[info["example"]]
            client = clients[info["example"]]
            base = client["sent"]
            bars = [{"name": "client: request → result", "start": 0, "dur": (client["received"] - base) / 1000, "depth": 0}]
            depth_of = {"run": 1, "queued": 2, "runner": 2, "drain events": 2, "send result": 1}
            for span in sorted(entry["spans"], key=lambda s: s["ts"]):
                name = span["name"]
                depth = depth_of.get(name, 3 if name.startswith("phase ") else 4)
                if name == "fork+exec":
                    depth = 5
                bars.append({"name": name, "start": (span["ts"] - base) / 1000, "dur": span["dur"] / 1000, "depth": depth})
            examples[language] = bars
        template = (Path(__file__).parent / "trace-report.template.html").read_text()
        data = json.dumps({"summary": summary, "examples": examples}).replace("</", "<\\/")
        html.write_text(template.replace("/*__DATA__*/null", data))
        print(f"\nwrote {html}")


if __name__ == "__main__":
    main()
