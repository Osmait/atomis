import unittest

from pylive_instrument import instrument

SAMPLE = """def apply_tax(price, tax):
    inner = price + tax
    return inner


price = 40
tax: int = 3
a, b = 1, 2
total = apply_tax(price, tax)
for i in range(3):
    print("iter", i)
while total > 100:
    total = total - 1
print("total:", total)
values = [
    price,
    total,
]
"""


class InstrumentTests(unittest.TestCase):
    def test_probes_simple_assignments_top_level_included(self):
        result = instrument(SAMPLE, "file:///main.py", True, [], 1)
        generated = result["generated"]
        self.assertIsNotNone(generated)
        self.assertEqual(SAMPLE.count("\n"), generated.count("\n"))
        self.assertIn('price = 40; _atomis_probe("', generated)
        self.assertIn('"price", price)', generated)
        self.assertIn('tax: int = 3; _atomis_probe("', generated)
        self.assertIn('inner = price + tax; _atomis_probe("', generated)
        self.assertIn('], "values", values)'.replace("], ", ', '), generated)
        supported = [p for p in result["probes"] if p["supported"]]
        unsupported = [p for p in result["probes"] if not p["supported"]]
        # inner, price, tax, total, total (reassign in while), values
        self.assertEqual(len(supported), 6)
        self.assertEqual(len(unsupported), 1)
        self.assertEqual(unsupported[0]["reason"], "destructuring pattern")

    def test_multiline_statement_inserts_after_the_closing_line(self):
        result = instrument(SAMPLE, "file:///main.py", True, [], 1)
        self.assertIn(']; _atomis_probe("', result["generated"])

    def test_log_markers_track_loops(self):
        result = instrument(SAMPLE, "file:///main.py", True, [], 7)
        generated = result["generated"]
        self.assertIn(
            '; _atomis_log_loop(1, 7, 11, 5, 10, 1, "i", i)', generated
        )
        self.assertIn("; _atomis_log(1, 7, 14, 1)", generated)

    def test_manual_mode_inserts_only_selected(self):
        everything = instrument(SAMPLE, "file:///main.py", True, [], 1)
        price = next(
            p for p in everything["probes"] if p["name"] == "price"
        )
        none = instrument(SAMPLE, "file:///main.py", False, [], 1)
        self.assertNotIn("_atomis_probe", none["generated"])
        selected = instrument(
            SAMPLE, "file:///main.py", False, [price["probeId"]], 1
        )
        self.assertIn('"price", price)', selected["generated"])

    def test_parse_errors_carry_positions(self):
        result = instrument("x = (\n", "file:///main.py", True, [], 1)
        self.assertIsNone(result["generated"])
        self.assertGreaterEqual(result["parseDiagnostics"][0]["line"], 1)

    def test_instrumented_source_passes_through(self):
        source = 'x = 1; _atomis_probe("a", 1, 1, "x", x)\n'
        result = instrument(source, "file:///main.py", True, [], 1)
        self.assertEqual(result["generated"], source)
        self.assertEqual(result["probes"], [])

    def test_the_generated_code_actually_runs(self):
        # The regression that motivates this: probe calls inside a class
        # body used to start with two underscores, Python name-mangled them
        # to _Config__atomis_probe, and every class with an attribute died
        # with NameError at definition time. Executing the output is the
        # only assertion that cannot lie about it.
        source = (
            "class Config:\n"
            "    debug = True\n"
            "    retries: int = 3\n"
            "total = Config.retries\n"
            "print(total)\n"
        )
        result = instrument(source, "file:///main.py", True, [], 1)
        generated = result["generated"]
        self.assertIsNotNone(generated)
        self.assertIn("debug = True; _atomis_probe(", generated)
        seen = []
        namespace = {
            "_atomis_probe": lambda *args: seen.append(args[3]),
            "_atomis_log": lambda *args: None,
            "_atomis_log_loop": lambda *args: None,
        }
        import io
        from contextlib import redirect_stdout

        with redirect_stdout(io.StringIO()):
            exec(compile(generated, "main.py", "exec"), namespace)  # noqa: S102
        self.assertIn("debug", seen)
        self.assertIn("total", seen)

    def test_a_file_with_a_bom_still_instruments(self):
        # Editors on Windows prepend U+FEFF; CPython runs such a file, so
        # the instrumenter must too — read with plain utf-8 the BOM reached
        # ast.parse and came back as a bogus syntax error on line 1.
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout

        from pylive_instrument import main

        with tempfile.TemporaryDirectory() as workdir:
            source_path = f"{workdir}/main.py"
            with open(source_path, "wb") as handle:
                handle.write("x = 1\nprint(x)\n".encode("utf-8-sig"))
            captured = io.StringIO()
            with redirect_stdout(captured):
                exit_code = main([
                    "--input", source_path,
                    "--output", f"{workdir}/out.py",
                    "--source-map", f"{workdir}/map.json",
                ])
            self.assertEqual(exit_code, 0)
            payload = json.loads(captured.getvalue())
            self.assertEqual(payload["parseDiagnostics"], [])
            with open(f"{workdir}/out.py", encoding="utf-8") as handle:
                self.assertIn('x = 1; _atomis_probe("', handle.read())


if __name__ == "__main__":
    unittest.main()
