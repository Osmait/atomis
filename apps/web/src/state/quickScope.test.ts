import { describe, expect, it } from "vitest";
import { charMatchColumns, quickScopeTargets } from "./quickScope.js";

describe("quickScopeTargets", () => {
	it("marks each following word's first uniquely reachable character", () => {
		//            1234567890123456789012
		const line = "const total = price;";
		const targets = quickScopeTargets(line, 1);
		// "total": t and o already occur inside "const", so the landing char
		// is a (col 10); "price" starts with an unseen p (col 15).
		expect(targets.primary).toEqual([10, 15]);
	});

	it("degrades to a secondary target when no char is unique", () => {
		//            12345678
		const line = "ab ab ab";
		const targets = quickScopeTargets(line, 1);
		// second ab: a is order 1
		expect(targets.primary).toEqual([4]);
		// third ab: a is order 2
		expect(targets.secondary).toEqual([7]);
	});

	it("looks in both directions from the cursor", () => {
		//            1234567890123456
		const line = "alpha beta gamma";
		// cursor on the g
		const targets = quickScopeTargets(line, 12);
		// F direction: alpha lands on l (a repeats three times), beta on b.
		expect(targets.primary).toContain(2);
		expect(targets.primary).toContain(7);
	});

	it("is case sensitive like f itself", () => {
		//            1234567890123
		const line = "x Total total";
		const targets = quickScopeTargets(line, 1);
		// T of Total is unique
		expect(targets.primary).toEqual([3]);
		// t of total is order 2
		expect(targets.secondary).toEqual([9]);
	});

	it("returns nothing on an empty or cursor-only line", () => {
		expect(quickScopeTargets("", 1)).toEqual({ primary: [], secondary: [] });
		expect(quickScopeTargets("word", 1).primary).toEqual([]);
	});
});

describe("charMatchColumns", () => {
	it("lists every occurrence of the chosen character", () => {
		expect(charMatchColumns("const std = std;", "s")).toEqual([4, 7, 13]);
		expect(charMatchColumns("abc", "z")).toEqual([]);
		expect(charMatchColumns("abc", "ab")).toEqual([]);
	});
});
