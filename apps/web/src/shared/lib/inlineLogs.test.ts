import { describe, expect, it } from "vitest";
import { groupLogsByLine } from "./inlineLogs.js";
import type { TerminalEntry } from "./terminalFolds.js";

const entry = (
	chunk: string,
	line: number,
	executionIndex: number,
	overrides: Partial<TerminalEntry> = {},
): TerminalEntry => ({
	stream: "stderr",
	category: "program",
	chunk,
	receivedAt: 1,
	sourceLocation: { path: "src/main.zig", line, column: 2, executionIndex },
	...overrides,
});

describe("groupLogsByLine", () => {
	it("keeps the latest value and the execution count per line", () => {
		const logs = groupLogsByLine(
			[entry("tick 0\n", 3, 1), entry("tick 1\n", 3, 2), entry("tick 2\n", 3, 3)],
			{ activePath: "main.zig", entryFile: "main.zig" },
		);
		expect(logs.get(3)).toMatchObject({
			text: "tick 2",
			count: 3,
			history: ["tick 0", "tick 1", "tick 2"],
			isError: false,
		});
	});

	it("only shows the active file's logs and skips unattributed output", () => {
		const logs = groupLogsByLine(
			[
				entry("mine\n", 1, 1),
				entry("other file\n", 2, 1, {
					sourceLocation: {
						path: "src/util.zig",
						line: 2,
						column: 1,
						executionIndex: 1,
					},
				}),
				{ stream: "stdout", category: "program", chunk: "plain\n", receivedAt: 1 },
			],
			{ activePath: "main.zig", entryFile: "main.zig" },
		);
		expect([...logs.keys()]).toEqual([1]);
	});

	it("flags error output and survives the buffer cap via executionIndex", () => {
		const logs = groupLogsByLine(
			[entry("boom\n", 5, 90, { category: "error" }), entry("boom\n", 5, 91, { category: "error" })],
			{ activePath: "main.zig", entryFile: "main.zig" },
		);
		expect(logs.get(5)).toMatchObject({ count: 91, isError: true });
	});

	it("sanitizes ANSI escapes and carriage returns before previewing", () => {
		const esc = String.fromCodePoint(0x1b);
		const logs = groupLogsByLine(
			[
				entry(`${esc}[31mboom${esc}[0m\n`, 1, 1),
				entry("0%\r100%\n", 2, 1),
			],
			{ activePath: "main.zig", entryFile: "main.zig" },
		);
		expect(logs.get(1)?.text).toBe("boom");
		expect(logs.get(2)?.text).toBe("100%");
	});

	it("skips blank chunks and caps long previews", () => {
		const long = "x".repeat(200);
		const logs = groupLogsByLine(
			[entry("\n", 1, 1), entry(`${long}\n`, 2, 1)],
			{ activePath: "main.zig", entryFile: "main.zig" },
		);
		expect(logs.has(1)).toBe(false);
		expect(logs.get(2)?.text.length).toBe(121);
		expect(logs.get(2)?.text.endsWith("…")).toBe(true);
	});
});
