#!/usr/bin/env python3
"""Atomis test runner for Python sessions.

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


def collect_tests(module, module_name):
    """`test_*` functions, plus the methods of `unittest.TestCase` classes —
    the standard shape a Python test file takes, which used to be skipped in
    silence and summarized as 0/0."""
    for name, value in list(vars(module).items()):
        if isinstance(value, type):
            if issubclass(value, unittest.TestCase) and value is not unittest.TestCase:
                for method_name in sorted(vars(value)):
                    if not method_name.startswith("test"):
                        continue
                    if not callable(getattr(value, method_name, None)):
                        continue
                    yield (
                        f"{name}.{method_name}",
                        _bound_case(value, method_name),
                    )
            # A class merely named test_* is not a callable test.
            continue
        if name.startswith("test_") and callable(value):
            yield name, value


def _bound_case(case_class, method_name):
    def run():
        case = case_class(method_name)
        result = unittest.TestResult()
        case.run(result)
        for _, message in result.errors + result.failures:
            raise AssertionError(message)
        if result.skipped:
            raise unittest.SkipTest(result.skipped[0][1])

    return run


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
        for name, value in list(collect_tests(module, module_name)):
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
                outcome = value()
                # A generator named test_* "passes" without running a line;
                # drive it so its asserts actually execute.
                if hasattr(outcome, "__next__"):
                    for _ in outcome:
                        pass
            except unittest.SkipTest:
                status = "skipped"
            except SystemExit as error:
                # A test calling sys.exit() must not take the runner (and
                # every remaining test, and the summary) down with it.
                status = "failed"
                error_name = f"SystemExit({error.code})"
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
