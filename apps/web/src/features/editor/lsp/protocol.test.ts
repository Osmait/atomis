import { describe, expect, it } from "vitest";
import {
	answerServerRequest,
	completionInsertText,
	fromMonacoBounds,
	lspSeverityName,
	normalizeHoverContents,
	toMonacoPosition,
	toMonacoRange,
} from "./protocol.js";

describe("coordinate conversion", () => {
	it("converts LSP 0-based to Monaco 1-based and back", () => {
		expect(toMonacoPosition({ line: 0, character: 4 })).toEqual({
			lineNumber: 1,
			column: 5,
		});
		expect(
			toMonacoRange({
				start: { line: 1, character: 0 },
				end: { line: 1, character: 3 },
			}),
		).toEqual({
			startLineNumber: 2,
			startColumn: 1,
			endLineNumber: 2,
			endColumn: 4,
		});
		expect(fromMonacoBounds(2, 1, 2, 4)).toEqual({
			start: { line: 1, character: 0 },
			end: { line: 1, character: 3 },
		});
	});
});

describe("lspSeverityName", () => {
	it("maps 1–4 with error as the default", () => {
		expect(lspSeverityName(1)).toBe("error");
		expect(lspSeverityName(2)).toBe("warning");
		expect(lspSeverityName(3)).toBe("information");
		expect(lspSeverityName(4)).toBe("hint");
		expect(lspSeverityName(undefined)).toBe("error");
	});
});

describe("normalizeHoverContents", () => {
	it("handles strings, MarkedString objects and arrays", () => {
		expect(normalizeHoverContents("hola")).toEqual([{ value: "hola" }]);
		expect(
			normalizeHoverContents({ language: "zig", value: "const x = 1;" }),
		).toEqual([{ value: "```zig\nconst x = 1;\n```" }]);
		expect(normalizeHoverContents([null, "a", { value: "b" }])).toEqual([
			{ value: "a" },
			{ value: "b" },
		]);
	});
});

describe("completionInsertText", () => {
	it("prefers textEdit, then insertText, then the label", () => {
		expect(
			completionInsertText({
				label: "l",
				insertText: "i",
				textEdit: {
					newText: "t",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				},
			}),
		).toBe("t");
		expect(completionInsertText({ label: "l", insertText: "i" })).toBe("i");
		expect(completionInsertText({ label: "l" })).toBe("l");
	});
});

describe("answerServerRequest", () => {
	it("returns one empty config per requested section", () =>
		expect(
			answerServerRequest("workspace/configuration", {
				items: [{ section: "a" }, { section: "b" }],
			}),
		).toEqual([{}, {}]));
	it("refuses server-initiated edits and nulls the rest", () => {
		expect(answerServerRequest("workspace/applyEdit", {})).toMatchObject({
			applied: false,
		});
		expect(answerServerRequest("window/anything", {})).toBeNull();
	});
});
