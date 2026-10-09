#!/usr/bin/env python3
"""pylive-instrument as a long-lived process, like ts/instrumenter/worker.mjs.

The CLI started an interpreter and imported the instrumenter for every file
of every run, and the CPU profile showed that start-up, not instrumenting,
was nine tenths of its cost. This process starts once. The server sends one
JSON request per line and reads one JSON answer per line; the worker never
opens a file — the server reads the source and writes the results — and
`instrument` keeps no state between calls, so one process can serve every
session that uses the system interpreter.

Request: {"id", "source", "uri", "version", "fileId", "autoInspect",
          "manual", "output", "sourceMap"}
Answer:  {"id", "json", "generated"} — `json` exactly what the CLI prints,
         `generated` null when the source did not parse — or {"id", "error"}.
"""

import json
import sys
import traceback

from pylive_instrument import instrument, render


def answer(request):
    source = request["source"]
    # The CLI reads with utf-8-sig, which drops a leading byte-order mark.
    if source.startswith("﻿"):
        source = source[1:]
    result = instrument(
        source,
        request["uri"],
        request["autoInspect"],
        request["manual"],
        request["fileId"],
    )
    payload = render(result, request["output"], request["sourceMap"], request["version"])
    return {"id": request["id"], "json": payload, "generated": result["generated"]}


def main():
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            reply = answer(request)
        except Exception:  # noqa: BLE001 — every failure goes back as an answer
            reply = {"id": request_id, "error": traceback.format_exc()}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
