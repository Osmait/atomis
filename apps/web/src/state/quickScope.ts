/**
 * clever-f-style helper for the vim f/F/t/T motions: once the target
 * character is typed, every occurrence of it is highlighted so the jump
 * (and its `;`/`,` repeats) is visible. The f motion itself stays
 * line-scoped — matches on other lines are informational.
 */
export interface CharMatch {
	line: number;
	column: number;
}

/** 1-based columns of every occurrence of `char` on one line. */
export function charMatchColumns(lineText: string, char: string): number[] {
	if (char.length !== 1) return [];
	const columns: number[] = [];
	for (let index = 0; index < lineText.length; index++)
		if (lineText[index] === char) columns.push(index + 1);
	return columns;
}

/** Document-wide matches of `char`, capped so huge files stay cheap. */
export function charMatchPositions(
	lines: readonly string[],
	char: string,
	cap = 500,
): CharMatch[] {
	const matches: CharMatch[] = [];
	for (const [index, lineText] of lines.entries()) {
		for (const column of charMatchColumns(lineText, char)) {
			matches.push({ line: index + 1, column });
			if (matches.length >= cap) return matches;
		}
	}
	return matches;
}
