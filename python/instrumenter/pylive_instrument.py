#!/usr/bin/env python3
"""pylive-instrument: the Atomis source instrumenter for Python.

Mirrors the runzig/rustlive/golive/tslive contract — parse one file with the
stdlib `ast` module, record probe insertion points for simple assignments
(module level included: module bodies are executable) and source markers for
direct `print` statements, then splice the calls into the ORIGINAL text so
the generated copy keeps every byte and the exact newline count. `ast`
column offsets are UTF-8 byte offsets, so lines are spliced as bytes.
"""

import ast
import json
import os
import sys

MAX_SOURCE_BYTES = 1024 * 1024
FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK = 0xFFFFFFFFFFFFFFFF


def _fnv1a64(text):
    value = FNV_OFFSET
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * FNV_PRIME) & MASK
    return format(value, "016x")


def _probe_id(uri, start_byte, end_byte, name):
    key = f"pylive-v1|{uri}|{start_byte}-{end_byte}|{name}"
    return _fnv1a64(key) + _fnv1a64(key + "|2")


class Collector(ast.NodeVisitor):
    def __init__(self, uri, file_id, auto_inspect, manual_ids, line_starts):
        self.uri = uri
        self.file_id = file_id
        self.auto_inspect = auto_inspect
        self.manual_ids = set(manual_ids)
        self.line_starts = line_starts
        self.probes = []
        self.insertions = []
        self.loops = []

    def _offset(self, lineno, col_offset):
        return self.line_starts[lineno - 1] + col_offset

    def _record(self, name_node, statement, reason=None):
        name = name_node.id
        start_byte = self._offset(name_node.lineno, name_node.col_offset)
        end_byte = self._offset(
            name_node.end_lineno or name_node.lineno,
            name_node.end_col_offset or name_node.col_offset,
        )
        probe_id = _probe_id(self.uri, start_byte, end_byte, name)
        active = reason is None and (
            self.auto_inspect or probe_id in self.manual_ids
        )
        probe = {
            "probeId": probe_id,
            "name": name,
            "supported": reason is None,
            "originalRange": {
                "startLine": name_node.lineno,
                "startColumn": name_node.col_offset + 1,
                "endLine": name_node.end_lineno or name_node.lineno,
                "endColumn": (name_node.end_col_offset or name_node.col_offset)
                + 1,
                "startByte": start_byte,
                "endByte": end_byte,
            },
            "mode": "auto" if self.auto_inspect else "manual",
        }
        if reason is not None:
            probe["reason"] = reason
        if active:
            end_line = statement.end_lineno or statement.lineno
            end_col = statement.end_col_offset or 0
            probe["insertionByte"] = self._offset(end_line, end_col)
            self.insertions.append(
                (
                    end_line,
                    end_col,
                    '; _atomis_probe("%s", %d, %d, "%s", %s)'
                    % (
                        probe_id,
                        name_node.lineno,
                        name_node.col_offset + 1,
                        name,
                        name,
                    ),
                )
            )
        self.probes.append(probe)

    def visit_Assign(self, node):
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            self._record(node.targets[0], node)
        elif len(node.targets) == 1 and isinstance(
            node.targets[0], (ast.Tuple, ast.List)
        ):
            first = next(
                (
                    element
                    for element in node.targets[0].elts
                    if isinstance(element, ast.Name)
                ),
                None,
            )
            if first is not None:
                self._record(first, node, "destructuring pattern")
        elif len(node.targets) > 1 and isinstance(node.targets[0], ast.Name):
            self._record(node.targets[0], node, "multiple assignment")
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name):
            if node.value is not None:
                self._record(node.target, node)
            else:
                self._record(node.target, node, "declaration without initializer")
        self.generic_visit(node)

    def _visit_loop(self, node, variable):
        self.loops.append((node.lineno, node.col_offset + 1, variable))
        self.generic_visit(node)
        self.loops.pop()

    def visit_For(self, node):
        variable = ""
        if isinstance(node.target, ast.Name):
            variable = node.target.id
        elif isinstance(node.target, ast.Tuple):
            first = next(
                (
                    element
                    for element in node.target.elts
                    if isinstance(element, ast.Name)
                ),
                None,
            )
            if first is not None:
                variable = first.id
        self._visit_loop(node, variable)

    visit_AsyncFor = visit_For

    def visit_While(self, node):
        variable = next(
            (
                child.id
                for child in ast.walk(node.test)
                if isinstance(child, ast.Name)
            ),
            "",
        )
        self._visit_loop(node, variable)

    def visit_Expr(self, node):
        call = node.value
        if (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "print"
        ):
            end_line = node.end_lineno or node.lineno
            end_col = node.end_col_offset or 0
            enclosing = self.loops[-1] if self.loops else None
            if enclosing and enclosing[2]:
                loop_line, loop_col, variable = enclosing
                self.insertions.append(
                    (
                        end_line,
                        end_col,
                        '; _atomis_log_loop(1, %d, %d, %d, %d, %d, "%s", %s)'
                        % (
                            self.file_id,
                            node.lineno,
                            node.col_offset + 1,
                            loop_line,
                            loop_col,
                            variable,
                            variable,
                        ),
                    )
                )
            else:
                self.insertions.append(
                    (
                        end_line,
                        end_col,
                        "; _atomis_log(1, %d, %d, %d)"
                        % (self.file_id, node.lineno, node.col_offset + 1),
                    )
                )
        self.generic_visit(node)


def instrument(source, uri, auto_inspect, manual_ids, file_id):
    if "; _atomis_probe(\"" in source or "; _atomis_log(" in source or "; _atomis_log_loop(" in source:
        return {"generated": source, "probes": [], "parseDiagnostics": []}
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return {
            "generated": None,
            "probes": [],
            "parseDiagnostics": [
                {
                    "message": error.msg or "invalid syntax",
                    "line": error.lineno or 1,
                    "column": error.offset or 1,
                }
            ],
        }
    encoded_lines = [line.encode("utf-8") for line in source.split("\n")]
    line_starts = []
    offset = 0
    for line in encoded_lines:
        line_starts.append(offset)
        offset += len(line) + 1
    collector = Collector(uri, file_id, auto_inspect, manual_ids, line_starts)
    collector.visit(tree)
    collector.insertions.sort(key=lambda item: (item[0], item[1]), reverse=True)
    for line_number, col, text in collector.insertions:
        line = encoded_lines[line_number - 1]
        encoded_lines[line_number - 1] = (
            line[:col] + text.encode("utf-8") + line[col:]
        )
    generated = b"\n".join(encoded_lines).decode("utf-8")
    if generated.count("\n") != source.count("\n"):
        return {
            "generated": None,
            "probes": [],
            "parseDiagnostics": [
                {
                    "message": "instrumentation would change the line count",
                    "line": 1,
                    "column": 1,
                }
            ],
        }
    return {
        "generated": generated,
        "probes": collector.probes,
        "parseDiagnostics": [],
    }


def render(result, output, source_map, version):
    payload = {
        "protocolVersion": 1,
        "documentVersion": version,
    }
    if result["generated"] is not None:
        payload["generatedPath"] = output
        payload["sourceMapPath"] = source_map
    payload["probes"] = result["probes"]
    payload["parseDiagnostics"] = [
        {
            "message": item["message"],
            "severity": "error",
            "line": item["line"],
            "column": item["column"],
        }
        for item in result["parseDiagnostics"]
    ]
    return json.dumps(payload)


def main(argv):
    options = {
        "uri": "file:///main.py",
        "version": 1,
        "file_id": 0,
        "auto_inspect": True,
        "manual": [],
    }
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--no-auto-inspect":
            options["auto_inspect"] = False
        elif argument == "--entry":
            pass
        elif argument in {
            "--input",
            "--output",
            "--source-map",
            "--uri",
            "--version",
            "--file-id",
            "--manual",
        }:
            index += 1
            value = argv[index] if index < len(argv) else ""
            if argument == "--input":
                options["input"] = value
            elif argument == "--output":
                options["output"] = value
            elif argument == "--source-map":
                options["source_map"] = value
            elif argument == "--uri":
                options["uri"] = value
            elif argument == "--version":
                options["version"] = int(value)
            elif argument == "--file-id":
                options["file_id"] = int(value)
            else:
                options["manual"].append(value)
        else:
            print(f"pylive-instrument: invalid argument: {argument}", file=sys.stderr)
            return 1
        index += 1
    for required in ("input", "output", "source_map"):
        if required not in options:
            print("pylive-instrument: missing --input/--output/--source-map", file=sys.stderr)
            return 1
    if os.path.getsize(options["input"]) > MAX_SOURCE_BYTES:
        print(f"pylive-instrument: {options['input']} exceeds 1 MiB", file=sys.stderr)
        return 1
    with open(options["input"], encoding="utf-8-sig") as handle:
        source = handle.read()
    result = instrument(
        source,
        options["uri"],
        options["auto_inspect"],
        options["manual"],
        options["file_id"],
    )
    payload = render(result, options["output"], options["source_map"], options["version"])
    if result["generated"] is not None:
        with open(options["output"], "w", encoding="utf-8") as handle:
            handle.write(result["generated"])
        with open(options["source_map"], "w", encoding="utf-8") as handle:
            handle.write(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
