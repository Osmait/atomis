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
});

describe("normalizeFolderName", () => {
	it("strips trailing slashes only", () => {
		expect(normalizeFolderName("utils///")).toBe("utils");
		expect(normalizeFolderName("a/b")).toBe("a/b");
	});
});
