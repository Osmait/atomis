import { describe, expect, it } from "vitest";
import { isValidProjectPath, normalizeFolderName } from "./paths.js";

describe("isValidProjectPath", () => {
	it("accepts nested relative paths", () => {
		expect(isValidProjectPath("main.zig")).toBe(true);
		expect(isValidProjectPath("utils/deep/helper.zig")).toBe(true);
	});
	it("rejects traversal, absolutes and backslashes", () => {
		expect(isValidProjectPath("")).toBe(false);
		expect(isValidProjectPath("/etc/passwd")).toBe(false);
		expect(isValidProjectPath("a\\b.zig")).toBe(false);
		expect(isValidProjectPath("../x.zig")).toBe(false);
		expect(isValidProjectPath("a//b.zig")).toBe(false);
		expect(isValidProjectPath("a/./b.zig")).toBe(false);
	});

	it("enforces the server's 240-byte limit, measured in bytes", () => {
		expect(isValidProjectPath(`${"a".repeat(236)}.zig`)).toBe(true);
		expect(isValidProjectPath(`${"a".repeat(237)}.zig`)).toBe(false);
		// 130 characters, but 260 UTF-8 bytes — the server counts bytes.
		expect(isValidProjectPath("á".repeat(130))).toBe(false);
	});

	it("rejects control characters, as the server does", () => {
		expect(isValidProjectPath("a\tb.zig")).toBe(false);
		expect(isValidProjectPath("a\nb.zig")).toBe(false);
		expect(isValidProjectPath("a\u0000b.zig")).toBe(false);
	});

	it("rejects # and ?, which truncate the Monaco model URI", () => {
		expect(isValidProjectPath("a#b.zig")).toBe(false);
		expect(isValidProjectPath("a?b.zig")).toBe(false);
	});
});

describe("normalizeFolderName", () => {
	it("strips trailing slashes only", () => {
		expect(normalizeFolderName("utils///")).toBe("utils");
		expect(normalizeFolderName("a/b")).toBe("a/b");
	});
});
