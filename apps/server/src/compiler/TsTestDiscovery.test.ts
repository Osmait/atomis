import { describe, expect, it } from "vitest";
import {
	discoverTsTests,
	parseTapOutput,
	parseTscDiagnostics,
} from "./TsTestDiscovery.js";

describe("discoverTsTests", () => {
	it("finds test and it calls only in *.test files", () => {
		const tests = discoverTsTests([
			{
				path: "main.test.ts",
				source:
					'import { test } from "node:test";\n\ntest("suma el impuesto", () => {});\n  it(\'con "comillas"\', () => {});\n',
			},
			{ path: "main.ts", source: 'test("no cuenta", () => {});\n' },
		]);
		expect(tests.map((test) => [test.name, test.line])).toEqual([
			["suma el impuesto", 3],
			['con "comillas"', 4],
		]);
		expect(tests[0]?.path).toBe("src/main.test.ts");
	});
});

describe("parseTapOutput", () => {
	const sample = [
		"TAP version 13",
		"# Subtest: applyTax suma el impuesto",
		"ok 1 - applyTax suma el impuesto",
		"  ---",
		"  duration_ms: 0.593612",
		"  type: 'test'",
		"  ...",
		"# Subtest: falla esperada",
		"not ok 2 - falla esperada",
		"  ---",
		"  duration_ms: 0.591182",
		"  failureType: 'testCodeFailure'",
		"  error: |-",
		"    Expected values to be strictly equal:",
		"    ",
		"    40 !== 41",
		"    ",
		"  code: 'ERR_ASSERTION'",
		"  ...",
		"# Subtest: se salta",
		"ok 3 - se salta # SKIP",
		"  ---",
		"  duration_ms: 0.079981",
		"  ...",
		"1..3",
	].join("\n");

	it("parses statuses, duration and failure messages", () => {
		const results = parseTapOutput(sample);
		expect(results).toHaveLength(3);
		expect(results[0]).toMatchObject({
			name: "applyTax suma el impuesto",
			status: "passed",
			durationMs: 0.593612,
		});
		expect(results[1]).toMatchObject({ name: "falla esperada", status: "failed" });
		expect(results[1]?.message).toContain("40 !== 41");
		expect(results[2]).toMatchObject({ name: "se salta", status: "skipped" });
	});
});

describe("parseTscDiagnostics", () => {
	it("maps src-relative diagnostics and dedupes", () => {
		const stdout = [
			"src/main.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/main.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/util.ts(2,1): warning TS6133: 'x' is declared but never read.",
			"../outside.ts(1,1): error TS1000: ignored",
		].join("\n");
		const diagnostics = parseTscDiagnostics(stdout);
		expect(diagnostics).toEqual([
			{
				path: "src/main.ts",
				message: "Type 'string' is not assignable to type 'number'.",
				severity: "error",
				line: 4,
				column: 7,
				source: "tsc",
			},
			{
				path: "src/util.ts",
				message: "'x' is declared but never read.",
				severity: "warning",
				line: 2,
				column: 1,
				source: "tsc",
			},
		]);
	});
});
