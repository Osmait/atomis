import { describe, expect, it } from "vitest";
import { languageForPath, monacoLanguageFor } from "./languages.js";

describe("languageForPath", () => {
	it("routes by extension", () => {
		expect(languageForPath("main.zig")).toBe("zig");
		expect(languageForPath("deep/aoc.rs")).toBe("rust");
		expect(languageForPath("input.txt")).toBeUndefined();
	});
});

describe("monacoLanguageFor", () => {
	it("uses each pack's monaco id, with plain js as javascript", () => {
		expect(monacoLanguageFor("main.zig")).toBe("zig");
		expect(monacoLanguageFor("main.ts")).toBe("typescript");
		expect(monacoLanguageFor("script.mjs")).toBe("javascript");
	});
	it("covers asset types and falls back to plaintext", () => {
		expect(monacoLanguageFor("config.json")).toBe("json");
		expect(monacoLanguageFor("README.md")).toBe("markdown");
		expect(monacoLanguageFor("lib.h")).toBe("c");
		expect(monacoLanguageFor("lib.hpp")).toBe("cpp");
		expect(monacoLanguageFor("input.txt")).toBe("plaintext");
	});
});
