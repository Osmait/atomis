import { describe, expect, it } from "vitest";
import {
	applyBitop,
	bitArray,
	bitsForType,
	bytesLE,
	displayPreview,
	flipBit,
	formatInt,
	parseBitopLine,
	parseIntegerPreview,
	typeIsSigned,
} from "./lowlevel.js";

describe("parseIntegerPreview", () => {
	it("parses plain integers", () => {
		expect(parseIntegerPreview("42")).toBe(42n);
		expect(parseIntegerPreview("-7")).toBe(-7n);
		expect(parseIntegerPreview(" 250 ")).toBe(250n);
	});

	it("rejects non-integers", () => {
		expect(parseIntegerPreview("3.5")).toBeUndefined();
		expect(parseIntegerPreview("hola")).toBeUndefined();
		expect(parseIntegerPreview("{ 1, 2 }")).toBeUndefined();
		expect(parseIntegerPreview("true")).toBeUndefined();
	});
});

describe("bitsForType", () => {
	it("maps zig/rust integer names", () => {
		expect(bitsForType("u8")).toBe(8);
		expect(bitsForType("i32")).toBe(32);
		expect(bitsForType("u64")).toBe(64);
		expect(bitsForType("usize")).toBe(64);
	});

	it("maps C fixed-width and classic names", () => {
		expect(bitsForType("uint16_t")).toBe(16);
		expect(bitsForType("int")).toBe(32);
		expect(bitsForType("long")).toBe(64);
		expect(bitsForType("char")).toBe(8);
	});

	it("maps Go names", () => {
		expect(bitsForType("int8")).toBe(8);
		expect(bitsForType("uint32")).toBe(32);
		expect(bitsForType("int", "go")).toBe(64);
		expect(bitsForType("byte")).toBe(8);
	});

	it("returns undefined for non-integers", () => {
		expect(bitsForType("f64")).toBeUndefined();
		expect(bitsForType("[]const u8")).toBeUndefined();
		expect(bitsForType("Pixel")).toBeUndefined();
	});
});

describe("formatInt", () => {
	it("formats hex padded to the type width", () => {
		expect(formatInt(43n, 8, "hex")).toBe("0x2B");
		expect(formatInt(43n, 32, "hex")).toBe("0x0000002B");
	});

	it("formats grouped binary", () => {
		expect(formatInt(43n, 8, "bin")).toBe("0b0010_1011");
	});

	it("formats octal and chr", () => {
		expect(formatInt(43n, 8, "oct")).toBe("0o53");
		expect(formatInt(65n, 8, "chr")).toBe("'A'");
		expect(formatInt(9n, 8, "chr")).toBe("\\x9");
	});

	it("uses two's complement for negatives", () => {
		expect(formatInt(-1n, 8, "hex")).toBe("0xFF");
		expect(formatInt(-1n, 8, "bin")).toBe("0b1111_1111");
		expect(formatInt(-1n, 8, "dec")).toBe("-1");
	});

	it("handles 64-bit values via bigint", () => {
		expect(formatInt(2n ** 63n, 64, "hex")).toBe("0x8000000000000000");
	});
});

describe("bit helpers", () => {
	it("decomposes bits MSB-first", () => {
		expect(bitArray(43n, 8)).toEqual([0, 0, 1, 0, 1, 0, 1, 1]);
	});

	it("flips a bit by MSB index", () => {
		expect(flipBit(43n, 8, 0)).toBe(171n);
		expect(flipBit(43n, 8, 7)).toBe(42n);
	});

	it("decomposes little-endian bytes", () => {
		expect(bytesLE(0x1234n, 16)).toEqual([0x34, 0x12]);
		expect(bytesLE(255n, 8)).toEqual([255]);
	});
});

describe("parseBitopLine", () => {
	it("detects compound assignments", () => {
		expect(parseBitopLine("    flags <<= 1;")).toEqual({
			operator: "<<",
			operand: 1n,
		});
		expect(parseBitopLine("flags &= 0b1111_0000;")).toEqual({
			operator: "&",
			operand: 240n,
		});
	});

	it("detects self-referencing binary assignments", () => {
		expect(parseBitopLine("flags = flags << 1;")).toEqual({
			operator: "<<",
			operand: 1n,
		});
		expect(parseBitopLine("const y = x & 0xF0;")).toEqual({
			operator: "&",
			operand: 0xf0n,
		});
	});

	it("ignores unrelated lines", () => {
		expect(parseBitopLine("const total = applyTax(price);")).toBeUndefined();
		expect(parseBitopLine("if (a && b) {")).toBeUndefined();
		expect(parseBitopLine("x = y & mask;")).toBeUndefined();
	});
});

describe("applyBitop", () => {
	it("applies shifts and masks within the width", () => {
		expect(applyBitop(43n, { operator: "<<", operand: 1n }, 8)).toBe(86n);
		expect(applyBitop(86n, { operator: "&", operand: 240n }, 8)).toBe(80n);
		expect(applyBitop(200n, { operator: "<<", operand: 1n }, 8)).toBe(144n);
	});

	it("clamps huge shifts to the width instead of throwing", () => {
		// `x <<= 9999999999` used to raise a RangeError in the middle of
		// rendering the peek panel; a shift past the width is simply zero.
		expect(
			applyBitop(43n, { operator: "<<", operand: 9_999_999_999n }, 8),
		).toBe(0n);
		expect(
			applyBitop(43n, { operator: ">>", operand: 9_999_999_999n }, 8),
		).toBe(0n);
		expect(applyBitop(43n, { operator: "<<", operand: 8n }, 8)).toBe(0n);
		expect(applyBitop(43n, { operator: ">>", operand: 7n }, 8)).toBe(0n);
	});
});

describe("parseOperand via parseBitopLine", () => {
	it("reads a bare leading zero as C octal", () => {
		expect(parseBitopLine("flags &= 017;")).toEqual({
			operator: "&",
			operand: 15n,
		});
		expect(parseBitopLine("flags &= 0o17;")).toEqual({
			operator: "&",
			operand: 15n,
		});
		expect(parseBitopLine("flags &= 0;")).toEqual({
			operator: "&",
			operand: 0n,
		});
	});
});

describe("typeIsSigned", () => {
	it("treats u-prefixed and listed unsigned types as unsigned", () => {
		expect(typeIsSigned("u8")).toBe(false);
		expect(typeIsSigned("uint32_t")).toBe(false);
		expect(typeIsSigned("unsigned int")).toBe(false);
		expect(typeIsSigned("size_t")).toBe(false);
		expect(typeIsSigned("byte")).toBe(false);
	});

	it("keeps signed types signed", () => {
		expect(typeIsSigned("i32")).toBe(true);
		expect(typeIsSigned("int")).toBe(true);
		expect(typeIsSigned("ssize_t")).toBe(true);
		expect(typeIsSigned("ptrdiff_t")).toBe(true);
		expect(typeIsSigned("rune")).toBe(true);
	});
});

describe("displayPreview", () => {
	it("re-formats integers using type width", () => {
		const value = { preview: "43", typeName: "u8" };
		expect(displayPreview(value, "dec")).toBe("43");
		expect(displayPreview(value, "hex")).toBe("0x2B");
		expect(displayPreview(value, "bin")).toBe("0b0010_1011");
	});

	it("normalizes go hex previews in dec", () => {
		expect(displayPreview({ preview: "0x2b", typeName: "uint8" }, "dec")).toBe(
			"43",
		);
	});

	it("summarizes structs by layout", () => {
		expect(
			displayPreview(
				{
					preview: "Pixel{ .r = 255 }",
					typeName: "Pixel",
					sizeBytes: 4,
					alignBytes: 1,
					fields: [{}],
				},
				"hex",
			),
		).toBe("Pixel · 4 B · align 1");
	});

	it("never rebases pointer addresses", () => {
		const pointer = { preview: "0x1268695", typeName: "*const [4:0]u8" };
		expect(displayPreview(pointer, "dec")).toBe("0x1268695");
		expect(displayPreview(pointer, "bin")).toBe("0x1268695");
		expect(
			displayPreview({ preview: '"hola"', typeName: "*const [4:0]u8" }, "hex"),
		).toBe('"hola"');
	});

	it("keeps non-integer previews untouched", () => {
		expect(displayPreview({ preview: '"hola"', typeName: "char*" }, "hex")).toBe(
			'"hola"',
		);
	});
});
