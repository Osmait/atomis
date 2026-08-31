"""Atomis session runtime for Python.

Loaded automatically at interpreter startup because the generated mirror is
on PYTHONPATH, so the probe builtins exist before ANY user module executes —
the Python mirror of `node --import`. Probe values flow as NDJSON on fd 3;
log markers ride the same stream objects `print` uses so ordering is exact.
"""

import builtins
import json
import os
import reprlib
import sys

_MAX_PREVIEW = 512
_MARKER_START = "\x1e"
_MARKER_END = "\x1f"
_sequence = 0

# A bounded repr, not repr-then-truncate: a 100MB string or a hundred-million
# element list must not be materialized in full just to keep 512 characters —
# in a hot loop that is a stall or an OOM inside the user's own program.
_repr = reprlib.Repr()
_repr.maxstring = _MAX_PREVIEW
_repr.maxother = _MAX_PREVIEW
_repr.maxlist = _repr.maxtuple = _repr.maxset = _repr.maxfrozenset = 64
_repr.maxdict = 64
_repr.maxlevel = 4


def _truncate(preview):
    if len(preview) <= _MAX_PREVIEW:
        return preview, False
    return preview[:_MAX_PREVIEW] + "…", True


def _type_name(value):
    return type(value).__name__


def _preview_of(value):
    try:
        return _repr.repr(value)
    except Exception:  # noqa: BLE001 - user __repr__ may raise anything
        return "<preview unavailable>"


def _probe(probe_id, line, column, name, value):
    global _sequence
    preview = _preview_of(value)
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
        # "replace" and a broad except: a preview with a lone surrogate (a
        # user __repr__ can return anything) must degrade, never raise back
        # into the program at the probe site.
        os.write(3, (json.dumps(record) + "\n").encode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
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
    preview = _preview_of(value)
    preview, _ = _truncate(preview)
    # The marker travels in-band on stdout: a preview carrying the marker's
    # own delimiters (or a newline) would cut the frame short and leak the
    # rest as phantom output.
    preview = (
        preview.replace(_MARKER_START, "?")
        .replace(_MARKER_END, "?")
        .replace("\n", "\\n")
    )
    try:
        _stream(fd).write(
            f"{_MARKER_START}ATOMIS_LOG:{file_id}:{line}:{column}"
            f":{loop_line}:{loop_column}:{variable}:{preview}{_MARKER_END}"
        )
    except Exception:  # noqa: BLE001
        pass


builtins._atomis_probe = _probe
builtins._atomis_log = _log
builtins._atomis_log_loop = _log_loop
