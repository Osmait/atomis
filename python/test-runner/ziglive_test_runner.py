#!/usr/bin/env python3
"""ZigLive test runner for Python sessions.

Imports every given test file, runs its `test_*` functions sequentially, and
reports NDJSON events on fd 3 with the same schema as the Zig custom runner
(`test_start`, `test_result`, `test_summary`), so the server reuses the same
reader and stderr-correlation for failure messages.
"""

import importlib.util
import json
import os
import sys
import time
import traceback
import unittest


def emit(payload):
    try:
        os.write(3, (json.dumps(payload) + "\n").encode("utf-8"))
    except OSError:
        pass


def main(paths):
    if paths:
        sys.path.insert(0, os.path.dirname(os.path.abspath(paths[0])))
    index = 0
    passed = failed = skipped = 0
    for path in paths:
        module_name = os.path.splitext(os.path.basename(path))[0]
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:  # noqa: BLE001 - report and continue with other files
            traceback.print_exc()
            continue
        for name, value in list(vars(module).items()):
            if not name.startswith("test_") or not callable(value):
                continue
            qualified = f"{module_name}.{name}"
            emit(
                {
                    "protocolVersion": 1,
                    "kind": "test_start",
                    "index": index,
                    "name": qualified,
                }
            )
            started = time.perf_counter()
            status = "passed"
            error_name = None
            try:
                value()
            except unittest.SkipTest:
                status = "skipped"
            except Exception as error:  # noqa: BLE001
                traceback.print_exc()
                status = "failed"
                error_name = type(error).__name__
            duration_ns = int((time.perf_counter() - started) * 1_000_000_000)
            result = {
                "protocolVersion": 1,
                "kind": "test_result",
                "index": index,
                "name": qualified,
                "status": status,
                "durationNs": duration_ns,
            }
            if error_name is not None:
                result["error"] = error_name
            emit(result)
            if status == "passed":
                passed += 1
            elif status == "skipped":
                skipped += 1
            else:
                failed += 1
            index += 1
    emit(
        {
            "protocolVersion": 1,
            "kind": "test_summary",
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
            "leaked": 0,
        }
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
