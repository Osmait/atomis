import type { TestCase } from "@ziglive/protocol";

interface SourceFile {
	path: string;
	source: string;
}

const STRING_TEST = /^(\s*)test\s+"((?:[^"\\]|\\.)*)"/;
const DECL_TEST = /^(\s*)test\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;

function unescapeTitle(raw: string): string {
	return raw.replace(/\\(.)/g, "$1");
}

/**
 * Finds `test "…"` and `test identifier {` blocks in the visible sources.
 * Line/column follow the 1-based convention used by every other diagnostic.
 */
export function discoverTests(files: readonly SourceFile[]): TestCase[] {
	const tests: TestCase[] = [];
	for (const file of files) {
		if (!file.path.endsWith(".zig")) continue;
		const lines = file.source.split("\n");
		for (const [index, line] of lines.entries()) {
			const stringMatch = STRING_TEST.exec(line);
			const declMatch = stringMatch ? undefined : DECL_TEST.exec(line);
			const match = stringMatch ?? declMatch;
			if (match?.[1] === undefined || match[2] === undefined) continue;
			tests.push({
				testId: `${file.path}:${index + 1}`,
				path: `src/${file.path}`,
				name: stringMatch ? unescapeTitle(match[2]) : match[2],
				line: index + 1,
				column: match[1].length + 1,
			});
		}
	}
	return tests;
}

/**
 * Maps a runner-reported qualified name (for example
 * `src.two-sum.test.falla esperada`) back to a discovered test case. The
 * module prefix mirrors the import path of `test_root.zig` with slashes
 * replaced by dots and the `.zig` extension removed.
 */
export function matchRunnerName(
	catalog: readonly TestCase[],
	runnerName: string,
): TestCase | undefined {
	const marker = ".test.";
	const expectedPrefix = (path: string): string =>
		path.replace(/\.zig$/, "").replaceAll("/", ".");
	for (
		let markerIndex = runnerName.indexOf(marker);
		markerIndex >= 0;
		markerIndex = runnerName.indexOf(marker, markerIndex + 1)
	) {
		const prefix = runnerName.slice(0, markerIndex);
		const title = runnerName.slice(markerIndex + marker.length);
		const matched = catalog.find(
			(candidate) =>
				expectedPrefix(candidate.path) === prefix && candidate.name === title,
		);
		if (matched) return matched;
	}
	const fallbackTitle =
		runnerName.indexOf(marker) >= 0
			? runnerName.slice(runnerName.indexOf(marker) + marker.length)
			: (runnerName.split(".").at(-1) ?? runnerName);
	return catalog.find((candidate) => candidate.name === fallbackTitle);
}
