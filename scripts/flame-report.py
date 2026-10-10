#!/usr/bin/env python3
"""Builds a self-contained flame-graph page from folded stacks.

    python3 scripts/flame-report.py out.html "Steady load=steady.folded" "Cold start=warm.folded"

Each argument after the output names one view and its folded file (from
scripts/fold-perf.py, sampled every 1 ms of CPU, so one sample is 1 ms).
Frames under 0.1% of a view are merged into their parent to keep the page
small; the page itself draws and zooms the graph.
"""

import json
import sys
from pathlib import Path

PRUNE = 0.001


def tree(folded: Path) -> dict:
    root = {"name": "all", "value": 0, "children": {}}
    for line in folded.read_text().splitlines():
        stack, count = line.rsplit(" ", 1)
        count = int(count)
        node = root
        node["value"] += count
        for frame in stack.split(";"):
            child = node["children"].setdefault(frame, {"name": frame, "value": 0, "children": {}})
            child["value"] += count
            node = child
    total = root["value"]

    def pack(node: dict) -> dict:
        kids = [pack(c) for c in node["children"].values() if c["value"] >= total * PRUNE]
        kids.sort(key=lambda c: -c["v"])
        out = {"n": node["name"], "v": node["value"]}
        if kids:
            out["c"] = kids
        return out

    return pack(root)


def main() -> None:
    out = Path(sys.argv[1])
    views = []
    for spec in sys.argv[2:]:
        name, path = spec.split("=", 1)
        views.append({"name": name, "root": tree(Path(path))})
    template = (Path(__file__).parent / "flame-report.template.html").read_text()
    data = json.dumps(views, separators=(",", ":")).replace("</", "<\\/")
    out.write_text(template.replace("/*__DATA__*/null", data))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
