import { describe, expect, it } from "vitest";
import {
	changePairEdits,
	deletePairEdits,
	findEnclosingPair,
	surroundPairFor,
	wrapEdits,
} from "./surround.js";

describe("surroundPairFor", () => {
	it("maps brackets, aliases and quotes", () => {
		expect(surroundPairFor(")")).toMatchObject({
			open: "(",
			close: ")",
			padded: false,
		});
		expect(surroundPairFor("(")).toMatchObject({ padded: true });
		expect(surroundPairFor("b")).toMatchObject({ open: "(", close: ")" });
		expect(surroundPairFor('"')).toMatchObject({ open: '"', close: '"' });
		expect(surroundPairFor("x")).toBeUndefined();
	});
});

describe("findEnclosingPair", () => {
	it("finds the quote pair enclosing (or right of) the cursor", () => {
		const lines = ['say("hola") + say("mundo")'];
		expect(
			findEnclosingPair(lines, { line: 1, column: 7 }, '"'),
		).toEqual({
			open: { line: 1, column: 5 },
			close: { line: 1, column: 10 },
		});
		// Between the pairs → the next one to the right.
		expect(
			findEnclosingPair(lines, { line: 1, column: 13 }, '"'),
		).toMatchObject({ open: { line: 1, column: 19 } });
	});

	it("matches nested brackets from the cursor outward, across lines", () => {
		const lines = ["fn main() {", "  call(inner(x), y);", "}"];
		expect(
			findEnclosingPair(lines, { line: 2, column: 10 }, ")"),
		).toEqual({
			open: { line: 2, column: 7 },
			close: { line: 2, column: 19 },
		});
		expect(
			findEnclosingPair(lines, { line: 2, column: 5 }, "}"),
		).toEqual({
			open: { line: 1, column: 11 },
			close: { line: 3, column: 1 },
		});
	});

	it("counts the cursor sitting on the opener as inside", () => {
		const lines = ["(abc)"];
		expect(findEnclosingPair(lines, { line: 1, column: 1 }, ")")).toEqual({
			open: { line: 1, column: 1 },
			close: { line: 1, column: 5 },
		});
	});
});

describe("edits", () => {
	const pair = { open: "(", close: ")", padded: false };
	it("wraps a range end-first so columns stay valid", () => {
		const edits = wrapEdits(
			{ line: 1, column: 3 },
			{ line: 1, column: 8 },
			pair,
		);
		expect(edits[0]).toMatchObject({ startColumn: 8, text: ")" });
		expect(edits[1]).toMatchObject({ startColumn: 3, text: "(" });
	});
	it("pads with inner spaces for opener-style pairs", () => {
		const edits = wrapEdits(
			{ line: 1, column: 1 },
			{ line: 1, column: 4 },
			{ open: "(", close: ")", padded: true },
		);
		expect(edits[0]?.text).toBe(" )");
		expect(edits[1]?.text).toBe("( ");
	});
	it("deletes and changes both delimiters", () => {
		const found = {
			open: { line: 1, column: 5 },
			close: { line: 1, column: 10 },
		};
		expect(deletePairEdits(found)[0]).toMatchObject({
			startColumn: 10,
			endColumn: 11,
			text: "",
		});
		expect(
			changePairEdits(found, { open: "'", close: "'", padded: false })[1],
		).toMatchObject({ startColumn: 5, endColumn: 6, text: "'" });
	});
});
