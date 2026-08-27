/**
 * clever-f-style helper for the vim f/F/t/T motions: once the target
 * character is typed, every occurrence of it on the line is highlighted so
 * `;`/`,` repeats are visible. Nothing is shown before the character is
 * chosen.
 */

/** 1-based columns of every occurrence of `char` on the line. */
export function charMatchColumns(lineText: string, char: string): number[] {
	if (char.length !== 1) return [];
	const columns: number[] = [];
	for (let index = 0; index < lineText.length; index++)
		if (lineText[index] === char) columns.push(index + 1);
	return columns;
}
