import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./ansi.js";

const ESCAPE = String.fromCodePoint(0x1b);
const BELL = String.fromCodePoint(0x07);

describe("sanitizeTerminalText", () => {
	it("leaves plain text untouched", () => {
		expect(sanitizeTerminalText("hola mundo\n")).toBe("hola mundo\n");
	});

	it("strips CSI color sequences", () => {
		expect(
			sanitizeTerminalText(`${ESCAPE}[31mrojo${ESCAPE}[0m normal`),
		).toBe("rojo normal");
		expect(sanitizeTerminalText(`${ESCAPE}[1;32;40mverde${ESCAPE}[m`)).toBe(
			"verde",
		);
	});

	it("strips cursor-movement and erase sequences", () => {
		expect(sanitizeTerminalText(`${ESCAPE}[2K${ESCAPE}[1Gline`)).toBe("line");
		expect(sanitizeTerminalText(`${ESCAPE}[?25hshown`)).toBe("shown");
	});

	it("strips OSC sequences with BEL and ST terminators", () => {
		expect(sanitizeTerminalText(`${ESCAPE}]0;title${BELL}after`)).toBe("after");
		expect(sanitizeTerminalText(`${ESCAPE}]8;;https://x${ESCAPE}\\link`)).toBe(
			"link",
		);
	});

	it("strips single-character escapes", () => {
		expect(sanitizeTerminalText(`a${ESCAPE}Mb`)).toBe("ab");
	});

	it("keeps only the last frame of a carriage-return progress bar", () => {
		expect(sanitizeTerminalText("0%\r50%\r100%")).toBe("100%");
	});

	it("collapses carriage returns per line, not across lines", () => {
		expect(sanitizeTerminalText("a\rb\nc\rd\n")).toBe("b\nd\n");
	});

	it("treats a trailing carriage return as erasing nothing", () => {
		expect(sanitizeTerminalText("done\r")).toBe("done");
		expect(sanitizeTerminalText("a\r\nb")).toBe("a\nb");
	});

	it("handles colored progress bars — escapes first, then overwrite", () => {
		expect(
			sanitizeTerminalText(`${ESCAPE}[32m25%${ESCAPE}[0m\r${ESCAPE}[32m50%${ESCAPE}[0m`),
		).toBe("50%");
	});
});
