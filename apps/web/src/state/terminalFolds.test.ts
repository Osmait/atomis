import { describe, expect, it } from "vitest";
import { groupOutput, type TerminalEntry } from "./terminalFolds.js";

function line(
	chunk: string,
	options: Partial<TerminalEntry> = {},
): TerminalEntry {
	return {
		stream: "stdout",
		category: "program",
		chunk,
		receivedAt: 0,
		...options,
	};
}

function loopLine(chunk: string, executionIndex: number): TerminalEntry {
	return line(chunk, {
		stream: "stderr",
		sourceLocation: {
			path: "src/main.zig",
			line: 4,
			column: 9,
			executionIndex,
			loop: { line: 3, column: 5, variable: "i", value: String(executionIndex - 1) },
		},
	});
}

describe("groupOutput", () => {
	it("keeps short runs as plain lines", () => {
		const rows = groupOutput([
			line("hola\n"),
			loopLine("iter 0\n", 1),
			loopLine("iter 1\n", 2),
			loopLine("iter 2\n", 3),
		]);
		expect(rows.every((row) => row.kind === "line")).toBe(true);
	});

	it("folds four or more lines from the same source statement", () => {
		const rows = groupOutput([
			line("inicio\n"),
			loopLine("iter 0\n", 1),
			loopLine("iter 1\n", 2),
			loopLine("iter 2\n", 3),
			loopLine("iter 3\n", 4),
			line("fin\n"),
		]);
		expect(rows.map((row) => row.kind)).toEqual(["line", "fold", "line"]);
		const fold = rows[1];
		if (fold?.kind !== "fold") throw new Error("expected fold");
		expect(fold.label).toBe("trace · src/main.zig:4:9 · loop i");
		expect(fold.entries).toHaveLength(4);
		expect(fold.entries[0]?.index).toBe(1);
	});

	it("folds the error trace after a panic line", () => {
		const trace = (chunk: string): TerminalEntry =>
			line(chunk, { stream: "stderr", category: "error" });
		const rows = groupOutput([
			line("antes\n"),
			trace("thread 100 panic: boom\n"),
			trace("/lib/std/debug.zig:415:5\n"),
			trace("main.zig:4:5: in main\n"),
			trace("start.zig:100:2: in start\n"),
		]);
		expect(rows.map((row) => row.kind)).toEqual(["line", "line", "fold"]);
		const fold = rows[2];
		if (fold?.kind !== "fold") throw new Error("expected fold");
		expect(fold.label).toBe("panic trace");
		expect(fold.entries).toHaveLength(3);
	});
});
