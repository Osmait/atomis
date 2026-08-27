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
        self.assertIn('price = 40; __atomis_probe("', generated)
        self.assertIn('"price", price)', generated)
        self.assertIn('tax: int = 3; __atomis_probe("', generated)
        self.assertIn('inner = price + tax; __atomis_probe("', generated)
        self.assertIn('], "values", values)'.replace("], ", ', '), generated)
        supported = [p for p in result["probes"] if p["supported"]]
        unsupported = [p for p in result["probes"] if not p["supported"]]
        # inner, price, tax, total, total (reassign in while), values
        self.assertEqual(len(supported), 6)
        self.assertEqual(len(unsupported), 1)
        self.assertEqual(unsupported[0]["reason"], "patrón de desestructuración")

    def test_multiline_statement_inserts_after_the_closing_line(self):
        result = instrument(SAMPLE, "file:///main.py", True, [], 1)
        self.assertIn(']; __atomis_probe("', result["generated"])

    def test_log_markers_track_loops(self):
        result = instrument(SAMPLE, "file:///main.py", True, [], 7)
        generated = result["generated"]
        self.assertIn(
            '; __atomis_log_loop(1, 7, 11, 5, 10, 1, "i", i)', generated
        )
        self.assertIn("; __atomis_log(1, 7, 14, 1)", generated)

    def test_manual_mode_inserts_only_selected(self):
        everything = instrument(SAMPLE, "file:///main.py", True, [], 1)
        price = next(
            p for p in everything["probes"] if p["name"] == "price"
        )
        none = instrument(SAMPLE, "file:///main.py", False, [], 1)
        self.assertNotIn("__atomis_probe", none["generated"])
        selected = instrument(
            SAMPLE, "file:///main.py", False, [price["probeId"]], 1
        )
        self.assertIn('"price", price)', selected["generated"])

    def test_parse_errors_carry_positions(self):
        result = instrument("x = (\n", "file:///main.py", True, [], 1)
        self.assertIsNone(result["generated"])
        self.assertGreaterEqual(result["parseDiagnostics"][0]["line"], 1)

    def test_instrumented_source_passes_through(self):
        source = 'x = 1; __atomis_probe("a", 1, 1, "x", x)\n'
        result = instrument(source, "file:///main.py", True, [], 1)
        self.assertEqual(result["generated"], source)
        self.assertEqual(result["probes"], [])


if __name__ == "__main__":
    unittest.main()
