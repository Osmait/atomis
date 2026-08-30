import { describe, expect, it } from "vitest";
import { charMatchColumns, charMatchPositions } from "./quickScope.js";

describe("charMatchColumns", () => {
	it("lists every occurrence of the chosen character", () => {
		expect(charMatchColumns("const std = std;", "s")).toEqual([4, 7, 13]);
	});
	it("is case sensitive and ignores non-single inputs", () => {
		expect(charMatchColumns("Tt", "t")).toEqual([2]);
		expect(charMatchColumns("abc", "z")).toEqual([]);
		expect(charMatchColumns("abc", "ab")).toEqual([]);
		expect(charMatchColumns("abc", "Escape")).toEqual([]);
	});
});

describe("charMatchPositions", () => {
	it("collects matches across every line", () => {
		expect(charMatchPositions(["ab", "ba", "xx"], "a")).toEqual([
			{ line: 1, column: 1 },
			{ line: 2, column: 2 },
		]);
	});
	it("stops at the cap", () => {
		expect(charMatchPositions(["aaaa", "aaaa"], "a", 5)).toHaveLength(5);
	});
});
