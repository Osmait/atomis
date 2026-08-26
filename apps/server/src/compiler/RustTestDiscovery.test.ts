import { describe, expect, it } from "vitest";
import { parseCargoDiagnostics } from "../diagnostics/CargoDiagnostics.js";
import { discoverRustTests, matchRustTestName } from "./RustTestDiscovery.js";
import {
	extractFailureMessages,
	findTestExecutable,
	parseLibtestLine,
	parseLibtestSummary,
} from "./RustTestOutput.js";

describe("discoverRustTests", () => {
	it("finds #[test] functions with attributes in between", () => {
		const tests = discoverRustTests([
			{
				path: "main.rs",
				source:
					"fn main() {}\n\n#[test]\nfn suma() {\n}\n\n#[test]\n#[ignore]\nfn lento() {}\n\n#[tokio::test]\nasync fn asincrono() {}\n",
			},
			{ path: "notas.txt", source: "#[test]\nfn no() {}\n" },
		]);
		expect(tests.map((test) => [test.name, test.line])).toEqual([
			["suma", 4],
			["lento", 9],
			["asincrono", 12],
		]);
		expect(tests[0]?.testId).toBe("main.rs:4");
		expect(tests[0]?.path).toBe("src/main.rs");
	});

	it("maps qualified libtest names back to files", () => {
		const catalog = discoverRustTests([
			{ path: "main.rs", source: "#[test]\nfn parsea() {}\n" },
			{
				path: "solver.rs",
				source: "mod tests {\n#[test]\nfn parsea() {}\n}\n",
			},
		]);
		expect(matchRustTestName(catalog, "solver::tests::parsea")?.testId).toBe(
			"solver.rs:3",
		);
		expect(matchRustTestName(catalog, "parsea")?.testId).toBe("main.rs:2");
		expect(matchRustTestName(catalog, "tests::desconocido")).toBe(undefined);
	});
});

describe("libtest output", () => {
	const sample = [
		"",
		"running 3 tests",
		"test falla ... FAILED",
		"test ignorado ... ignored",
		"test pasa ... ok",
		"",
		"failures:",
		"",
		"---- falla stdout ----",
		"",
		"thread 'falla' (110) panicked at src/main.rs:10:14:",
		"assertion `left == right` failed",
		"  left: 5",
		" right: 4",
		"note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
		"",
		"",
		"failures:",
		"    falla",
		"",
		"test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
		"",
	].join("\n");

	it("parses result lines, failure blocks and the summary", () => {
		expect(parseLibtestLine("test falla ... FAILED")).toEqual({
			name: "falla",
			status: "FAILED",
		});
		expect(parseLibtestLine("test tests::x ... ok")).toEqual({
			name: "tests::x",
			status: "ok",
		});
		expect(parseLibtestLine("running 3 tests")).toBe(undefined);
		const messages = extractFailureMessages(sample);
		expect(messages.get("falla")).toContain(
			"assertion `left == right` failed",
		);
		expect(parseLibtestSummary(sample)).toEqual({
			passed: 1,
			failed: 1,
			ignored: 1,
		});
	});

	it("finds the test executable in cargo JSON output", () => {
		const stdout = [
			JSON.stringify({
				reason: "compiler-artifact",
				profile: { test: false },
				target: { name: "ziglive-check" },
				executable: "/x/a",
			}),
			JSON.stringify({
				reason: "compiler-artifact",
				profile: { test: true },
				target: { name: "ziglive-check" },
				executable: "/x/b",
			}),
			"warning: junk",
		].join("\n");
		expect(findTestExecutable(stdout, "ziglive-check")).toBe("/x/b");
	});
});

describe("parseCargoDiagnostics", () => {
	it("maps generated spans to visible src paths and dedupes", () => {
		const line = JSON.stringify({
			reason: "compiler-message",
			message: {
				level: "error",
				message: "mismatched types",
				code: { code: "E0308" },
				spans: [
					{
						file_name: "generated/main.rs",
						line_start: 2,
						line_end: 2,
						column_start: 18,
						column_end: 22,
						is_primary: true,
					},
				],
			},
		});
		const noise = JSON.stringify({
			reason: "compiler-message",
			message: {
				level: "error",
				message: "aborting due to 1 previous error",
				spans: [],
			},
		});
		const diagnostics = parseCargoDiagnostics([line, line, noise].join("\n"));
		expect(diagnostics).toEqual([
			{
				path: "src/main.rs",
				message: "mismatched types",
				severity: "error",
				line: 2,
				column: 18,
				endLine: 2,
				endColumn: 22,
				code: "E0308",
				source: "rustc",
			},
		]);
	});
});
