import { describe, expect, it } from "vitest";
import {
	flattenProblems,
	primaryDiagnostic,
	problemsByLine,
	severityColor,
	type OwnedDiagnostic,
} from "./diagnostics.js";

const diagnostic = (
	overrides: Partial<OwnedDiagnostic> & { owner: string },
): OwnedDiagnostic => ({
	message: "boom",
	severity: "error",
	line: 1,
	column: 1,
	...overrides,
});

describe("flattenProblems", () => {
	it("drops diagnostics repeated by a second owner", () => {
		const flat = flattenProblems(
			{
				compiler: [{ message: "boom", severity: "error", line: 3, column: 2 }],
				zls: [
					{ message: "boom", severity: "error", line: 3, column: 2 },
					{ message: "otro", severity: "warning", line: 4, column: 1 },
				],
			},
			"main.zig",
		);
		expect(flat).toHaveLength(2);
		expect(flat.map((item) => item.owner)).toEqual(["compiler", "zls"]);
	});

	it("keeps the same typo in two different files as two problems", () => {
		const flat = flattenProblems(
			{
				"zls:main.zig": [
					{
						message: "boom",
						severity: "error",
						line: 3,
						column: 2,
						path: "src/main.zig",
					},
				],
				"zls:util.zig": [
					{
						message: "boom",
						severity: "error",
						line: 3,
						column: 2,
						path: "src/util.zig",
					},
				],
			},
			"main.zig",
		);
		expect(flat).toHaveLength(2);
	});

	it("still dedupes an unattributed compiler entry against the LSP's", () => {
		// The compiler reports the entry file without a path; the LSP names
		// it. They resolve to the same document, so one problem is listed.
		const flat = flattenProblems(
			{
				compiler: [{ message: "boom", severity: "error", line: 3, column: 2 }],
				"zls:main.zig": [
					{
						message: "boom",
						severity: "error",
						line: 3,
						column: 2,
						path: "src/main.zig",
					},
				],
			},
			"main.zig",
		);
		expect(flat).toHaveLength(1);
	});
});

describe("problemsByLine", () => {
	it("keeps only the active file's in-range lines, deduped per line", () => {
		const byLine = problemsByLine(
			[
				diagnostic({ owner: "a", line: 2 }),
				diagnostic({ owner: "b", line: 2 }),
				diagnostic({ owner: "a", line: 2, message: "otra cosa" }),
				diagnostic({ owner: "a", line: 99 }),
				diagnostic({ owner: "a", line: 1, path: "src/other.zig" }),
			],
			{ activePath: "main.zig", entryFile: "main.zig", lineCount: 10 },
		);
		expect([...byLine.keys()]).toEqual([2]);
		expect(byLine.get(2)).toHaveLength(2);
	});
});

describe("primaryDiagnostic", () => {
	it("picks the highest severity", () => {
		const primary = primaryDiagnostic([
			diagnostic({ owner: "a", severity: "hint" }),
			diagnostic({ owner: "a", severity: "error" }),
			diagnostic({ owner: "a", severity: "warning" }),
		]);
		expect(primary.severity).toBe("error");
	});
});

describe("severityColor", () => {
	it("maps severities to the lens palette", () => {
		expect(severityColor("error")).toBe("#f14c4c");
		expect(severityColor("warning")).toBe("#cca700");
		expect(severityColor("hint")).toBe("#3794ff");
	});
});
