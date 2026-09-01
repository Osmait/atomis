/**
 * Terminal-output sanitizing. User programs print what a real terminal would
 * interpret — ANSI color escapes from a logger with force_color, `\r`-driven
 * progress bars — but the output panel renders plain text, so the escapes
 * showed up raw (`\x1b[31m`) and every progress frame piled into the line.
 */

/** Escape character, built rather than written so no control character has
 * to appear inside a regular expression source. */
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

/**
 * CSI sequences (colors, cursor movement), OSC sequences (titles, links —
 * terminated by BEL or ST), and the remaining single-character escapes, in
 * that order so the two-character introducers are not eaten as singles.
 */
const ANSI_PATTERN = new RegExp(
	[
		`${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
		`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
		`${ESC}[@-Z\\\\^_\`]`,
	].join("|"),
	"g",
);

/**
 * Within each newline-delimited line, text after a `\r` overwrites what came
 * before it — the way a terminal shows a progress bar, keeping only the last
 * frame. A trailing `\r` (cursor parked at column 0, nothing written yet)
 * erases nothing, which also makes `\r\n` line endings plain line endings.
 */
function collapseCarriageReturns(line: string): string {
	let end = line.length;
	while (end > 0 && line[end - 1] === "\r") end--;
	const trimmed = line.slice(0, end);
	const lastReturn = trimmed.lastIndexOf("\r");
	return lastReturn === -1 ? trimmed : trimmed.slice(lastReturn + 1);
}

/** What the output panel and the inline logs actually render. */
export function sanitizeTerminalText(text: string): string {
	const stripped = text.includes(ESC) ? text.replaceAll(ANSI_PATTERN, "") : text;
	if (!stripped.includes("\r")) return stripped;
	return stripped.split("\n").map((line) => collapseCarriageReturns(line)).join("\n");
}
