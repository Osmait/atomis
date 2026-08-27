"""Atomis session runtime for Python.

Loaded automatically at interpreter startup because the generated mirror is
on PYTHONPATH, so the probe builtins exist before ANY user module executes —
the Python mirror of `node --import`. Probe values flow as NDJSON on fd 3;
log markers ride the same stream objects `print` uses so ordering is exact.
"""

import builtins
import json
import os
import sys

_MAX_PREVIEW = 512
_MARKER_START = "\x1e"
_MARKER_END = "\x1f"
_sequence = 0


def _truncate(preview):
    if len(preview) <= _MAX_PREVIEW:
        return preview, False
    return preview[:_MAX_PREVIEW] + "…", True


def _type_name(value):
    return type(value).__name__


def _probe(probe_id, line, column, name, value):
    global _sequence
    try:
        preview = repr(value)
    except Exception:  # noqa: BLE001 - user __repr__ may raise anything
        preview = "<preview unavailable>"
    preview, truncated = _truncate(preview)
    record = {
        "protocolVersion": 1,
        "kind": "probe_value",
        "probeId": probe_id,
        "name": name,
        "line": line,
        "column": column,
        "typeName": _type_name(value),
        "preview": preview,
        "truncated": truncated,
        "sequence": _sequence,
    }
    _sequence += 1
    try:
        os.write(3, (json.dumps(record) + "\n").encode("utf-8"))
    except OSError:
        pass


def _stream(fd):
    return sys.stdout if fd == 1 else sys.stderr


def _log(fd, file_id, line, column):
    try:
        _stream(fd).write(
            f"{_MARKER_START}ATOMIS_LOG:{file_id}:{line}:{column}{_MARKER_END}"
        )
    except Exception:  # noqa: BLE001
        pass


def _log_loop(fd, file_id, line, column, loop_line, loop_column, variable, value):
    try:
        preview = repr(value)
    except Exception:  # noqa: BLE001
        preview = "<preview unavailable>"
    preview, _ = _truncate(preview)
    try:
        _stream(fd).write(
            f"{_MARKER_START}ATOMIS_LOG:{file_id}:{line}:{column}"
            f":{loop_line}:{loop_column}:{variable}:{preview}{_MARKER_END}"
        )
    except Exception:  # noqa: BLE001
        pass


builtins.__atomis_probe = _probe
builtins.__atomis_log = _log
builtins.__atomis_log_loop = _log_loop
