import type { TestCase } from "@ziglive/protocol";

interface SourceFile {
	path: string;
	source: string;
}

const TEST_ATTR = /^\s*#\[\s*(?:[A-Za-z_][\w]*::)*test\b/;
const FN_LINE = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/;
const OTHER_ATTR = /^\s*#\[/;

/**
 * Finds `#[test]` functions in the visible `.rs` sources. The reported line
 * and column point at the `fn` declaration so the editor lens lands on the
 * test name; extra attributes (`#[ignore]`, `#[should_panic]`) between the
 * test attribute and the function are tolerated.
 */
export function discoverRustTests(files: readonly SourceFile[]): TestCase[] {
	const tests: TestCase[] = [];
	for (const file of files) {
		if (!file.path.endsWith(".rs")) continue;
		const lines = file.source.split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!TEST_ATTR.test(lines[index] ?? "")) continue;
			for (let lookahead = index + 1; lookahead < lines.length; lookahead++) {
				const line = lines[lookahead] ?? "";
				const fnMatch = FN_LINE.exec(line);
				if (fnMatch?.[1]) {
					tests.push({
						testId: `${file.path}:${lookahead + 1}`,
						path: `src/${file.path}`,
						name: fnMatch[1],
						line: lookahead + 1,
						column: (/^\s*/.exec(line)?.[0]?.length ?? 0) + 1,
					});
					index = lookahead;
					break;
				}
				if (!OTHER_ATTR.test(line) && line.trim() !== "") break;
			}
		}
	}
	return tests;
}

/**
 * Maps a libtest-qualified name (`tests::parsea_lineas`, or just `parsea`)
 * back to a discovered test. The final `::` segment is the function name;
 * earlier segments are module path hints matched against the file stem.
 */
export function matchRustTestName(
	catalog: readonly TestCase[],
	runnerName: string,
): TestCase | undefined {
	const segments = runnerName.split("::");
	const title = segments.at(-1) ?? runnerName;
	const modules = segments.slice(0, -1);
	const byTitle = catalog.filter((candidate) => candidate.name === title);
	if (byTitle.length <= 1) return byTitle[0];
	const scored = byTitle.map((candidate) => {
		const stem = candidate.path
			.replace(/^src\//, "")
			.replace(/\.rs$/, "")
			.split("/");
		const score = modules.filter((module) => stem.includes(module)).length;
		return { candidate, score };
	});
	scored.sort((left, right) => right.score - left.score);
	return scored[0]?.candidate;
}
