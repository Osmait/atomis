import { describe, expect, it } from "vitest";
import {
	discoverGoTests,
	parseGoDiagnostics,
	parseGoTestEvents,
} from "./GoTestDiscovery.js";

describe("discoverGoTests", () => {
	it("finds TestXxx functions only in _test.go files", () => {
		const tests = discoverGoTests([
			{
				path: "main_test.go",
				source:
					"package main\n\nimport \"testing\"\n\nfunc TestSuma(t *testing.T) {}\n\nfunc helper() {}\n\nfunc TestResta(t *testing.T) {}\n",
			},
			{ path: "main.go", source: "func TestNo(t *testing.T) {}\n" },
		]);
		expect(tests.map((test) => [test.name, test.line, test.testId])).toEqual([
			["TestSuma", 5, "main_test.go:5"],
			["TestResta", 9, "main_test.go:9"],
		]);
	});
});

describe("parseGoTestEvents", () => {
	it("folds NDJSON events into per-test results with messages", () => {
		const stdout = [
			JSON.stringify({ Action: "run", Test: "TestFalla" }),
			JSON.stringify({
				Action: "output",
				Test: "TestFalla",
				Output: "=== RUN   TestFalla\n",
			}),
			JSON.stringify({
				Action: "output",
				Test: "TestFalla",
				Output: "    main_test.go:13: esperado 41, recibido 40\n",
			}),
			JSON.stringify({
				Action: "output",
				Test: "TestFalla",
				Output: "--- FAIL: TestFalla (0.00s)\n",
			}),
			JSON.stringify({ Action: "fail", Test: "TestFalla", Elapsed: 0.01 }),
			JSON.stringify({ Action: "pass", Test: "TestPasa", Elapsed: 0.002 }),
			JSON.stringify({ Action: "skip", Test: "TestSalta", Elapsed: 0 }),
			JSON.stringify({ Action: "fail", Elapsed: 0.02 }),
		].join("\n");
		const results = parseGoTestEvents(stdout);
		expect(results).toEqual([
			{
				name: "TestFalla",
				status: "failed",
				durationMs: 10,
				message: "main_test.go:13: esperado 41, recibido 40",
			},
			{ name: "TestPasa", status: "passed", durationMs: 2 },
			{ name: "TestSalta", status: "skipped", durationMs: 0 },
		]);
	});
});

describe("parseGoDiagnostics", () => {
	it("maps generated paths to src and dedupes", () => {
		const stderr = [
			"# ziglive/generated",
			"generated/main.go:6:2: undefined: foo",
			"generated/main.go:6:2: undefined: foo",
			"/tmp/x/src/util.go:3:1: expected declaration",
			"exit status 1",
		].join("\n");
		expect(parseGoDiagnostics(stderr)).toEqual([
			{
				path: "src/main.go",
				message: "undefined: foo",
				severity: "error",
				line: 6,
				column: 2,
				source: "go",
			},
			{
				path: "src/util.go",
				message: "expected declaration",
				severity: "error",
				line: 3,
				column: 1,
				source: "go",
			},
		]);
	});
});
