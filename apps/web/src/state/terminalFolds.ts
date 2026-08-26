export interface TerminalSourceLocation {
	path?: string;
	line: number;
	column: number;
	executionIndex: number;
	loop?: { line: number; column: number; variable: string; value: string };
}

export interface TerminalEntry {
	stream: "stdout" | "stderr";
	category: "program" | "error";
	chunk: string;
	receivedAt: number;
	sourceLocation?: TerminalSourceLocation;
}

export type TerminalRow =
	| { kind: "line"; entry: TerminalEntry; index: number }
	| {
			kind: "fold";
			key: string;
			label: string;
			entries: { entry: TerminalEntry; index: number }[];
	  };

const LOOP_FOLD_MIN = 4;
const STACK_FOLD_MIN = 3;

function sourceKey(entry: TerminalEntry): string | undefined {
	const location = entry.sourceLocation;
	if (!location) return undefined;
	return `${location.path ?? "src/main.zig"}:${location.line}:${location.column}`;
}

/**
 * Groups repetitive terminal output into collapsible folds: runs of lines
 * produced by the same source statement (loop traces) and the error trace
 * that follows a panic line. Every other entry stays a plain line.
 */
export function groupOutput(entries: readonly TerminalEntry[]): TerminalRow[] {
	const rows: TerminalRow[] = [];
	let index = 0;
	while (index < entries.length) {
		const entry = entries[index];
		if (!entry) break;
		const key = sourceKey(entry);
		if (key) {
			let end = index;
			while (end < entries.length) {
				const candidate = entries[end];
				if (!candidate || sourceKey(candidate) !== key) break;
				end++;
			}
			if (end - index >= LOOP_FOLD_MIN) {
				const location = entry.sourceLocation;
				const loopSuffix = location?.loop
					? ` · bucle ${location.loop.variable}`
					: "";
				rows.push({
					kind: "fold",
					key: `loop:${key}:${index}`,
					label: `traza · ${key}${loopSuffix}`,
					entries: entries
						.slice(index, end)
						.map((grouped, offset) => ({
							entry: grouped,
							index: index + offset,
						})),
				});
				index = end;
				continue;
			}
		}
		rows.push({ kind: "line", entry, index });
		index++;
		if (entry.category === "error" && /(?:^|\s)panic:/i.test(entry.chunk)) {
			let end = index;
			while (end < entries.length) {
				const candidate = entries[end];
				if (
					!candidate ||
					candidate.category !== "error" ||
					/(?:^|\s)panic:/i.test(candidate.chunk)
				)
					break;
				end++;
			}
			if (end - index >= STACK_FOLD_MIN) {
				rows.push({
					kind: "fold",
					key: `stack:${index}`,
					label: "traza del panic",
					entries: entries
						.slice(index, end)
						.map((grouped, offset) => ({
							entry: grouped,
							index: index + offset,
						})),
				});
				index = end;
			}
		}
	}
	return rows;
}
