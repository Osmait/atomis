/**
 * Low-level value tooling: numeric re-formatting (dec/hex/bin/oct/chr) for
 * inline probe values, bit decomposition for the peek panel, and type-name →
 * bit-width inference for the low-level language packs.
 */

export type ValueFmt = "dec" | "hex" | "bin" | "oct" | "chr";

export const VALUE_FMTS: readonly ValueFmt[] = [
	"dec",
	"hex",
	"bin",
	"oct",
	"chr",
];

const INTEGER_PREVIEW = /^-?\d+$/;

/** Parses a probe preview into an integer, or undefined for non-integers. */
export function parseIntegerPreview(preview: string): bigint | undefined {
	const trimmed = preview.trim();
	if (!INTEGER_PREVIEW.test(trimmed)) return undefined;
	try {
		return BigInt(trimmed);
	} catch {
		return undefined;
	}
}

const ZIG_RUST_INT = /^[iu](\d+)$/;
const C_FIXED_INT = /^u?int(8|16|32|64)_t$/;
const GO_INT = /^u?int(8|16|32|64)?$/;

const C_WIDTHS: Record<string, number> = {
	char: 8,
	"signed char": 8,
	"unsigned char": 8,
	short: 16,
	"short int": 16,
	"unsigned short": 16,
	int: 32,
	"unsigned int": 32,
	unsigned: 32,
	long: 64,
	"long int": 64,
	"unsigned long": 64,
	"long long": 64,
	"unsigned long long": 64,
	size_t: 64,
	ssize_t: 64,
	ptrdiff_t: 64,
	bool: 8,
	_Bool: 8,
};

/**
 * Infers the bit width of an integer type from its language-level name
 * (`u8`, `i32`, `uint16_t`, `long`, `int32`, …). Bare `int`/`uint` are
 * 64-bit in Go and 32-bit in the C family, so the caller passes the file's
 * language to disambiguate. Returns undefined for non-integer types.
 */
export function bitsForType(
	typeName: string,
	language?: string,
): number | undefined {
	const name = typeName.trim();
	const zigRust = ZIG_RUST_INT.exec(name);
	if (zigRust?.[1]) {
		const bits = Number(zigRust[1]);
		return bits >= 1 && bits <= 128 ? bits : undefined;
	}
	if (name === "isize" || name === "usize") return 64;
	if (name === "comptime_int") return 64;
	const cFixed = C_FIXED_INT.exec(name);
	if (cFixed?.[1]) return Number(cFixed[1]);
	const go = GO_INT.exec(name);
	if (go?.[1]) return Number(go[1]);
	if ((name === "int" || name === "uint") && language === "go") return 64;
	if (name === "byte" || name === "rune") return name === "byte" ? 8 : 32;
	return C_WIDTHS[name];
}

/** True when the type name is a signed integer (affects chr/dec rendering). */
export function typeIsSigned(typeName: string): boolean {
	const name = typeName.trim();
	if (/^u/.test(name)) return false;
	if (/^unsigned/.test(name)) return false;
	return true;
}

const group = (text: string, size: number): string =>
	text.replace(new RegExp(`(.{${size}})(?=.)`, "g"), "$1_");

function unsignedValue(value: bigint, bits: number): bigint {
	return value < 0n ? value + (1n << BigInt(bits)) : value;
}

/**
 * Formats an integer in the selected base. Mirrors the design's `fmtVal`:
 * negatives render via two's complement in hex/bin/oct/chr, hex pads to the
 * type width, and bin groups nibbles with `_`.
 */
export function formatInt(
	value: bigint,
	bits: number | undefined,
	fmt: ValueFmt,
): string {
	const width = bits ?? 32;
	const unsigned = unsignedValue(value, width);
	if (fmt === "hex")
		return `0x${unsigned
			.toString(16)
			.toUpperCase()
			.padStart(Math.max(1, Math.ceil(width / 4)), "0")}`;
	if (fmt === "bin")
		return `0b${group(unsigned.toString(2).padStart(width, "0"), 4)}`;
	if (fmt === "oct") return `0o${unsigned.toString(8)}`;
	if (fmt === "chr")
		return unsigned >= 32n && unsigned < 127n
			? `'${String.fromCharCode(Number(unsigned))}'`
			: `\\x${unsigned.toString(16)}`;
	return value.toString();
}

/** MSB-first bit array for the peek panel's interactive bit grid. */
export function bitArray(value: bigint, bits: number): number[] {
	const unsigned = unsignedValue(value, bits);
	const out: number[] = [];
	for (let index = bits - 1; index >= 0; index--)
		out.push((unsigned >> BigInt(index)) & 1n ? 1 : 0);
	return out;
}

/** Flips one bit (MSB-first index) of a value within the given width. */
export function flipBit(value: bigint, bits: number, index: number): bigint {
	const unsigned = unsignedValue(value, bits) ^ (1n << BigInt(bits - 1 - index));
	return unsigned;
}

/** Little-endian byte decomposition for the peek panel's memory row. */
export function bytesLE(value: bigint, bits: number): number[] {
	const count = Math.max(1, Math.ceil(bits / 8));
	const unsigned = unsignedValue(value, bits);
	const out: number[] = [];
	for (let index = 0; index < count; index++)
		out.push(Number((unsigned >> BigInt(index * 8)) & 0xffn));
	return out;
}

export interface BitopInfo {
	operator: string;
	operand: bigint;
}

const BITOP_COMPOUND = /(?:^|[^&|^<>=!])([&|^]|<<|>>)=\s*([^;]+?)\s*;?\s*$/;
const BITOP_BINARY =
	/=\s*\w[\w.]*\s*(<<|>>|[&|^])\s*((?:0[xbo])?[\d_a-fA-F]+)\s*[;,]?\s*$/;

function parseOperand(text: string): bigint | undefined {
	const cleaned = text.trim().replaceAll("_", "").replace(/[;,]$/, "");
	if (!/^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO]?[0-7]*|\d+)$/.test(cleaned))
		return undefined;
	try {
		return BigInt(cleaned);
	} catch {
		return undefined;
	}
}

/**
 * Detects `x <<= 1` / `x = x & 0b1111` style lines so the peek panel can show
 * the operation rows (A op B = result). Purely lexical: only literal operands.
 */
export function parseBitopLine(lineText: string): BitopInfo | undefined {
	const compound = BITOP_COMPOUND.exec(lineText);
	if (compound?.[1] && compound[2]) {
		const operand = parseOperand(compound[2]);
		if (operand !== undefined)
			return { operator: compound[1], operand };
	}
	const binary = BITOP_BINARY.exec(lineText);
	if (binary?.[1] && binary[2]) {
		const operand = parseOperand(binary[2]);
		if (operand !== undefined) return { operator: binary[1], operand };
	}
	return undefined;
}

/** Applies a bit operation for the peek panel's derived result row. */
export function applyBitop(
	a: bigint,
	info: BitopInfo,
	bits: number,
): bigint {
	const mask = (1n << BigInt(bits)) - 1n;
	const ua = unsignedValue(a, bits);
	if (info.operator === "<<") return (ua << info.operand) & mask;
	if (info.operator === ">>") return ua >> info.operand;
	if (info.operator === "&") return ua & info.operand & mask;
	if (info.operator === "|") return (ua | info.operand) & mask;
	return (ua ^ info.operand) & mask;
}
