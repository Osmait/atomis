#!/usr/bin/env python3
"""Folds `perf script` output into flame-graph stacks, per process.

    perf script -F comm,pid,tid,time,event,ip,sym,dso > script.txt
    python3 scripts/fold-perf.py script.txt out.folded [--from 0.45 --to 0.92]

Unlike inferno-collapse-perf it keeps the samples whose user stack is empty,
which with `task-clock:u` are the ones taken inside the kernel (syscalls,
page faults, fork and exec): they appear as a `[kernel]` frame under their
process instead of vanishing, so the graph adds up to the CPU actually used.
Threads are grouped under the program they belong to, so a node process is
one tower rather than `MainThread`, `V8Worker` and `node` side by side.
`--from/--to` keep a slice of the recording, as fractions of its duration.

Runs of one repeated frame are merged — a stripped binary unwinds as a
chain of `[link]`, `[link]`, … and an interpreter as one eval frame per
call — and stacks deeper than MAX_DEPTH end in a `…` frame, so the graph
stays readable; widths are unaffected.
"""

import collections
import re
import sys

# perf names a sample by its thread; these threads belong to programs whose
# main thread has another name.
THREAD_GROUPS = {
    "MainThread": "node", "V8Worker": "node", "DelayedTaskSche": "node",
    "libuv-worker": "node", "node": "node",
    "tokio-rt-worker": "atomis-server", "atomis-server": "atomis-server",
    "coordinator": "rustc", "rustc": "rustc", "opt cgu.00": "rustc",
}
MAX_DEPTH = 40
HEADER = re.compile(r"^(?P<comm>.+?)\s+(?P<pid>\d+)/(?P<tid>\d+)\s+(?P<time>[\d.]+):\s+\S+:")
FRAME = re.compile(r"^\s+[0-9a-f]+\s+(?P<sym>.+?)\s+\((?P<dso>[^)]*)\)\s*$")


def group(comm: str) -> str:
    if comm in THREAD_GROUPS:
        return THREAD_GROUPS[comm]
    # Go's toolchain runs its own binaries; keep them apart by name.
    return comm


def frame_name(sym: str, dso: str) -> str:
    if sym != "[unknown]":
        # Long C++/Rust signatures make unreadable boxes; keep the path.
        sym = re.sub(r"\(.*\)$", "", sym)
        return sym.replace(";", ":")[:160]
    library = dso.rsplit("/", 1)[-1] or "?"
    return f"[{library}]"


def main() -> None:
    args = sys.argv[1:]
    source, target = args[0], args[1]
    lo = float(args[args.index("--from") + 1]) if "--from" in args else 0.0
    hi = float(args[args.index("--to") + 1]) if "--to" in args else 1.0

    samples = []  # (time, program, frames leaf-first)
    current = None
    with open(source, errors="replace") as text:
        for line in text:
            header = HEADER.match(line)
            if header:
                if current:
                    samples.append(current)
                current = (float(header["time"]), group(header["comm"].strip()), [])
                continue
            frame = FRAME.match(line)
            if frame and current:
                current[2].append(frame_name(frame["sym"], frame["dso"]))
    if current:
        samples.append(current)
    if not samples:
        sys.exit("no samples")

    start, end = samples[0][0], samples[-1][0]
    span = end - start or 1.0
    folded = collections.Counter()
    for time, program, frames in samples:
        if not lo <= (time - start) / span <= hi:
            continue
        stack = [program]
        for frame in reversed(frames) if frames else ["[kernel]"]:
            if frame != stack[-1]:
                stack.append(frame)
        if len(stack) > MAX_DEPTH:
            stack = stack[: MAX_DEPTH - 1] + ["…"]
        folded[";".join(stack)] += 1
    with open(target, "w") as out:
        for stack, count in folded.most_common():
            out.write(f"{stack} {count}\n")


if __name__ == "__main__":
    main()
