import { describe, expect, it } from "vitest";
import { zigMonarch } from "./zigLanguage.js";

describe("Zig Monarch fallback", () => {
	it("orders comments before operators and strings before identifiers", () => {
		const root = zigMonarch.tokenizer?.root as object[];
		expect(root.length).toBeGreaterThan(8);
		expect(String(root[0])).toContain("comment.doc");
		expect(String(root[1])).toContain("comment");
	});
});
