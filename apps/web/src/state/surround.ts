/**
 * vim-surround core: pair resolution, enclosing-pair search and the edit
 * lists for ys/cs/ds/S. Pure over an array of lines so every rule is unit
 * testable; the vim layer applies the edits through Monaco.
 */
export interface SurroundPair {
	open: string;
	close: string;
	/** Typing the OPEN character pads with inner spaces, vim-surround style. */
	padded: boolean;
}

export interface Position {
	/** 1-based. */
	line: number;
	/** 1-based. */
	column: number;
}

export interface EnclosingPair {
	open: Position;
	close: Position;
}

export interface SurroundEdit {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	text: string;
}

const BRACKETS: Record<string, { open: string; close: string }> = {
	"(": { open: "(", close: ")" },
	")": { open: "(", close: ")" },
	b: { open: "(", close: ")" },
	"[": { open: "[", close: "]" },
	"]": { open: "[", close: "]" },
	r: { open: "[", close: "]" },
	"{": { open: "{", close: "}" },
	"}": { open: "{", close: "}" },
	B: { open: "{", close: "}" },
	"<": { open: "<", close: ">" },
	">": { open: "<", close: ">" },
	a: { open: "<", close: ">" },
};

const QUOTES = new Set(['"', "'", "`"]);

export function surroundPairFor(char: string): SurroundPair | undefined {
	const bracket = BRACKETS[char];
	if (bracket)
		return {
			...bracket,
			padded: char === "(" || char === "[" || char === "{" || char === "<",
		};
	if (QUOTES.has(char)) return { open: char, close: char, padded: false };
	return undefined;
}

function findQuotePair(
	lines: readonly string[],
	cursor: Position,
	quote: string,
): EnclosingPair | undefined {
	const lineText = lines[cursor.line - 1] ?? "";
	const columns: number[] = [];
	for (let index = 0; index < lineText.length; index++)
		if (lineText[index] === quote && lineText[index - 1] !== "\\")
			columns.push(index + 1);
	for (let index = 0; index + 1 < columns.length; index += 2) {
		const open = columns[index]!;
		const close = columns[index + 1]!;
		// Enclosing pair first; otherwise vim-surround also acts on the
		// next pair to the right of the cursor.
		if (close >= cursor.column)
			return {
				open: { line: cursor.line, column: open },
				close: { line: cursor.line, column: close },
			};
	}
	return undefined;
}

function findBracketPair(
	lines: readonly string[],
	cursor: Position,
	open: string,
	close: string,
): EnclosingPair | undefined {
	// Backward for the unmatched opener (cursor sitting on it counts).
	let depth = 0;
	let openAt: Position | undefined;
	outer: for (let line = cursor.line; line >= 1; line--) {
		const text = lines[line - 1] ?? "";
		const from = line === cursor.line ? cursor.column - 1 : text.length - 1;
		for (let index = from; index >= 0; index--) {
			const char = text[index];
			if (char === close && !(line === cursor.line && index === cursor.column - 1))
				depth++;
			else if (char === open) {
				if (depth === 0) {
					openAt = { line, column: index + 1 };
					break outer;
				}
				depth--;
			}
		}
	}
	if (!openAt) return undefined;
	// Forward from just after the opener for its matching closer.
	depth = 0;
	for (let line = openAt.line; line <= lines.length; line++) {
		const text = lines[line - 1] ?? "";
		const from = line === openAt.line ? openAt.column : 0;
		for (let index = from; index < text.length; index++) {
			const char = text[index];
			if (char === open) depth++;
			else if (char === close) {
				if (depth === 0)
					return { open: openAt, close: { line, column: index + 1 } };
				depth--;
			}
		}
	}
	return undefined;
}

export function findEnclosingPair(
	lines: readonly string[],
	cursor: Position,
	char: string,
): EnclosingPair | undefined {
	const pair = surroundPairFor(char);
	if (!pair) return undefined;
	if (pair.open === pair.close) return findQuotePair(lines, cursor, pair.open);
	return findBracketPair(lines, cursor, pair.open, pair.close);
}

function insertAt(position: Position, text: string): SurroundEdit {
	return {
		startLine: position.line,
		startColumn: position.column,
		endLine: position.line,
		endColumn: position.column,
		text,
	};
}

/** ys / visual S: wrap [start, end) with the pair. */
export function wrapEdits(
	start: Position,
	end: Position,
	pair: SurroundPair,
): SurroundEdit[] {
	const open = pair.padded ? `${pair.open} ` : pair.open;
	const close = pair.padded ? ` ${pair.close}` : pair.close;
	return [insertAt(end, close), insertAt(start, open)];
}

/** ds: drop both delimiter characters. */
export function deletePairEdits(found: EnclosingPair): SurroundEdit[] {
	return [
		{
			startLine: found.close.line,
			startColumn: found.close.column,
			endLine: found.close.line,
			endColumn: found.close.column + 1,
			text: "",
		},
		{
			startLine: found.open.line,
			startColumn: found.open.column,
			endLine: found.open.line,
			endColumn: found.open.column + 1,
			text: "",
		},
	];
}

/** cs: swap both delimiter characters for the new pair. */
export function changePairEdits(
	found: EnclosingPair,
	next: SurroundPair,
): SurroundEdit[] {
	const open = next.padded ? `${next.open} ` : next.open;
	const close = next.padded ? ` ${next.close}` : next.close;
	return [
		{
			startLine: found.close.line,
			startColumn: found.close.column,
			endLine: found.close.line,
			endColumn: found.close.column + 1,
			text: close,
		},
		{
			startLine: found.open.line,
			startColumn: found.open.column,
			endLine: found.open.line,
			endColumn: found.open.column + 1,
			text: open,
		},
	];
}
