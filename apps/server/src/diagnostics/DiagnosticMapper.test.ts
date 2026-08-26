import { describe, expect, it } from "vitest";
import {
	filterObservedUnused,
	parseCompilerDiagnostics,
} from "./DiagnosticMapper.js";

const probe = {
	probeId: "p",
	name: "x",
	supported: true,
	insertionByte: 10,
	mode: "auto" as const,
	originalRange: {
		startLine: 2,
		startColumn: 3,
		endLine: 2,
		endColumn: 15,
		startByte: 3,
		endByte: 15,
	},
};

describe("diagnostics", () => {
	it("parses only conservative compiler locations", () => {
		expect(
			parseCompilerDiagnostics(
				"/tmp/main.zig:2:7: error: bad\nraw",
				"/tmp/main.zig",
			),
		).toEqual([
			expect.objectContaining({ line: 2, column: 7, message: "bad" }),
		]);
	});
	it("filters exact observed unused diagnostics only", () => {
		const diagnostics = [
			{
				message: "unused local constant",
				range: { start: { line: 1, character: 3 } },
			},
			{
				message: "type mismatch and unused value",
				range: { start: { line: 1, character: 3 } },
			},
			{
				message: "unused local constant",
				range: { start: { line: 4, character: 3 } },
			},
		];
		expect(filterObservedUnused(diagnostics, [probe])).toEqual([
			diagnostics[1],
			diagnostics[2],
		]);
	});
});
