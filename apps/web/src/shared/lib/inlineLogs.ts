import type { TerminalEntry } from "./terminalFolds.js";

/**
 * Console Ninja-style inline logs: groups the terminal output that carries
 * a source location by the emitting line of the active file, so the editor
 * can render each print/log statement's latest output as ghost text right
 * beside it. Works for every language because the instrumenters mark all
 * log statements with their line/column and execution index.
 */
export interface InlineLog {
	line: number;
	/** Latest chunk's first line, trimmed and capped. */
	text: string;
	/** Times the statement executed (survives the output-buffer cap). */
	count: number;
	/** Latest chunk lines, most recent last. */
	history: string[];
	isError: boolean;
}

const MAX_PREVIEW = 120;
const MAX_HISTORY = 20;

function previewOf(chunk: string): string {
	const first = (chunk.split("\n", 1)[0] ?? "").trim();
	return first.length > MAX_PREVIEW ? `${first.slice(0, MAX_PREVIEW)}…` : first;
}

export function groupLogsByLine(
	output: readonly TerminalEntry[],
	options: { activePath: string; entryFile: string },
): Map<number, InlineLog> {
	const document = `src/${options.activePath}`;
	const logs = new Map<number, InlineLog>();
	for (const entry of output) {
		const location = entry.sourceLocation;
		if (!location) continue;
		if ((location.path ?? `src/${options.entryFile}`) !== document) continue;
		const text = previewOf(entry.chunk);
		if (!text) continue;
		const existing = logs.get(location.line);
		if (existing) {
			existing.text = text;
			existing.count = Math.max(existing.count, location.executionIndex);
			existing.history = [...existing.history, text].slice(-MAX_HISTORY);
			existing.isError = existing.isError || entry.category === "error";
		} else {
			logs.set(location.line, {
				line: location.line,
				text,
				count: location.executionIndex,
				history: [text],
				isError: entry.category === "error",
			});
		}
	}
	return logs;
}
