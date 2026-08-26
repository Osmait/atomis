import { describe, expect, it } from "vitest";
import { discoverPyTests, matchPyTestName } from "./PyTestDiscovery.js";

describe("discoverPyTests", () => {
	it("finds test_ functions in test-named files only", () => {
		const tests = discoverPyTests([
			{
				path: "main_test.py",
				source:
					"from main import apply_tax\n\n\ndef test_suma():\n    pass\n\n\ndef helper():\n    pass\n\n\ndef test_resta():\n    pass\n",
			},
			{ path: "test_extra.py", source: "def test_extra():\n    pass\n" },
			{ path: "main.py", source: "def test_no():\n    pass\n" },
		]);
		expect(tests.map((test) => [test.name, test.testId])).toEqual([
			["test_suma", "main_test.py:4"],
			["test_resta", "main_test.py:12"],
			["test_extra", "test_extra.py:1"],
		]);
	});
});

describe("matchPyTestName", () => {
	it("maps module-qualified names and disambiguates by file stem", () => {
		const catalog = discoverPyTests([
			{ path: "main_test.py", source: "def test_parsea():\n    pass\n" },
			{ path: "solver_test.py", source: "def test_parsea():\n    pass\n" },
		]);
		expect(matchPyTestName(catalog, "solver_test.test_parsea")?.testId).toBe(
			"solver_test.py:1",
		);
		expect(matchPyTestName(catalog, "main_test.test_parsea")?.testId).toBe(
			"main_test.py:1",
		);
		expect(matchPyTestName(catalog, "otro.test_desconocido")).toBe(undefined);
	});
});
