/**
 * Quick-scope-style targets for the vim f/F/t/T motions: for every word on
 * the current line (in both directions from the cursor), the first
 * character that a single `f` (occurrence order 1, primary) or a repeated
 * `f;` (order 2, secondary) would reach. Highlighting these makes the
 * motion's landing spots visible before the key is pressed.
 */
export interface QuickScopeTargets {
	/** 1-based columns reachable with one f/F. */
	primary: number[];
	/** 1-based columns reachable with f/F followed by ;. */
	secondary: number[];
}

const WORD = /[A-Za-z0-9_]+/g;

interface Word {
	start: number;
	end: number;
}

function words(lineText: string): Word[] {
	const spans: Word[] = [];
	for (const match of lineText.matchAll(WORD))
		spans.push({ start: match.index, end: match.index + match[0].length - 1 });
	return spans;
}

function collect(
	lineText: string,
	indices: number[],
	spans: Word[],
	targets: QuickScopeTargets,
): void {
	// Occurrence order of each character along the motion's direction: `f`
	// lands on order 1, `f;` on order 2.
	const order = new Map<number, number>();
	const seen = new Map<string, number>();
	for (const index of indices) {
		const char = lineText[index] ?? "";
		const count = (seen.get(char) ?? 0) + 1;
		seen.set(char, count);
		order.set(index, count);
	}
	const included = new Set(indices);
	for (const span of spans) {
		if (!included.has(span.start)) continue;
		let primary: number | undefined;
		let secondary: number | undefined;
		for (let index = span.start; index <= span.end; index++) {
			const at = order.get(index);
			if (at === 1) {
				primary = index;
				break;
			}
			if (at === 2 && secondary === undefined) secondary = index;
		}
		if (primary !== undefined) targets.primary.push(primary + 1);
		else if (secondary !== undefined) targets.secondary.push(secondary + 1);
	}
}

export function quickScopeTargets(
	lineText: string,
	column: number,
): QuickScopeTargets {
	const cursor = column - 1;
	const targets: QuickScopeTargets = { primary: [], secondary: [] };
	const spans = words(lineText);

	const rightIndices: number[] = [];
	for (let index = cursor + 1; index < lineText.length; index++)
		rightIndices.push(index);
	collect(
		lineText,
		rightIndices,
		spans.filter((span) => span.start > cursor),
		targets,
	);

	const leftIndices: number[] = [];
	for (let index = cursor - 1; index >= 0; index--) leftIndices.push(index);
	collect(
		lineText,
		leftIndices,
		spans.filter((span) => span.end < cursor),
		targets,
	);
	// Left-side words are matched by their first character too, but their
	// occurrence order was computed right-to-left, so re-anchor per word:
	// for F the landing char is still the first single-occurrence one when
	// scanning the word left to right.
	return targets;
}
