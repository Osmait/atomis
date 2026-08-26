import { describe, expect, it } from "vitest";
import {
	buildCFamilyTestMain,
	discoverCFamilyTests,
	parseClangDiagnostics,
} from "./CFamilyDiscovery.js";

describe("discoverCFamilyTests", () => {
	it("finds void test_* functions in test files", () => {
		const tests = discoverCFamilyTests(
			[
				{
					path: "main_test.c",
					source:
						"#include <assert.h>\n\nvoid test_suma(void) {\n}\n\nstatic void helper(void) {}\n\nvoid test_resta() {\n}\n",
				},
				{ path: "main.c", source: "void test_no(void) {}\n" },
			],
			/_test\.c$/,
		);
		expect(tests.map((test) => [test.name, test.line])).toEqual([
			["test_suma", 3],
			["test_resta", 8],
		]);
	});
});

describe("parseClangDiagnostics", () => {
	it("maps generated paths and keeps warnings", () => {
		const stderr = [
			"generated/main.c:4:9: error: expected ';' at end of declaration",
			"/tmp/x/src/util.c:2:1: warning: unused variable 'x' [-Wunused]",
			"generated/main.c:4:9: note: candidate here",
			"generated/main.c:4:9: error: expected ';' at end of declaration",
		].join("\n");
		expect(parseClangDiagnostics(stderr)).toEqual([
			{
				path: "src/main.c",
				message: "expected ';' at end of declaration",
				severity: "error",
				line: 4,
				column: 9,
				source: "clang",
			},
			{
				path: "src/util.c",
				message: "unused variable 'x' [-Wunused]",
				severity: "warning",
				line: 2,
				column: 1,
				source: "clang",
			},
		]);
	});
});

describe("buildCFamilyTestMain", () => {
	it("declares and registers every test with the NDJSON schema", () => {
		const main = buildCFamilyTestMain(
			[
				{
					testId: "main_test.c:3",
					path: "src/main_test.c",
					name: "test_suma",
					line: 3,
					column: 1,
				},
			],
			"c",
		);
		expect(main).toContain("void test_suma(void);");
		expect(main).toContain('{"test_suma", test_suma},');
		expect(main).toContain('\\"kind\\":\\"test_start\\"');
		expect(main).toContain("_POSIX_C_SOURCE");
	});
});
