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
	it("maps standard-library errors to the generated call-site trace", () => {
		const generatedPath = "/tmp/ziglive/session/generated/main.zig";
		const stderr = `/usr/lib/zig/std/Io/Writer.zig:717:13: error: too few arguments
            @compileError("too few arguments");
referenced by:
    print__anon_32842: /usr/lib/zig/std/debug.zig:311:39
    main: generated/main.zig:6:24
    5 reference(s) hidden
`;
		expect(parseCompilerDiagnostics(stderr, generatedPath)).toEqual([
			expect.objectContaining({
				line: 6,
				column: 24,
				message: "too few arguments (/usr/lib/zig/std/Io/Writer.zig)",
			}),
		]);
	});

	it("does not map a dependency error onto a later unrelated diagnostic", () => {
		const generatedPath = "/tmp/ziglive/session/generated/main.zig";
		const stderr = `/usr/lib/zig/std/Io/Writer.zig:717:13: error: too few arguments
${generatedPath}:9:3: error: unrelated
`;
		expect(parseCompilerDiagnostics(stderr, generatedPath)[0]).toEqual(
			expect.objectContaining({ line: 717, column: 13 }),
		);
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
