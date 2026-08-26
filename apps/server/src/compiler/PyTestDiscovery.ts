import type { TestCase } from "@ziglive/protocol";

interface SourceFile {
	path: string;
	source: string;
}

export const PY_TEST_FILE = /(^|\/)test_[^/]*\.py$|_test\.py$/;
const TEST_FN = /^def (test_\w+)\s*\(/;

/**
 * Finds `def test_*` functions in the project's `test_*.py` / `*_test.py`
 * files — the same files the custom Python runner imports.
 */
export function discoverPyTests(files: readonly SourceFile[]): TestCase[] {
	const tests: TestCase[] = [];
	for (const file of files) {
		if (!PY_TEST_FILE.test(file.path)) continue;
		const lines = file.source.split("\n");
		for (const [index, line] of lines.entries()) {
			const match = TEST_FN.exec(line);
			if (!match?.[1]) continue;
			tests.push({
				testId: `${file.path}:${index + 1}`,
				path: `src/${file.path}`,
				name: match[1],
				line: index + 1,
				column: 1,
			});
		}
	}
	return tests;
}

/**
 * Maps the runner-qualified `module.test_fn` name back to a discovered test:
 * exact function-name match, disambiguated by the file stem.
 */
export function matchPyTestName(
	catalog: readonly TestCase[],
	runnerName: string,
): TestCase | undefined {
	const separator = runnerName.lastIndexOf(".");
	const title = separator >= 0 ? runnerName.slice(separator + 1) : runnerName;
	const moduleName = separator >= 0 ? runnerName.slice(0, separator) : "";
	const byTitle = catalog.filter((candidate) => candidate.name === title);
	if (byTitle.length <= 1) return byTitle[0];
	return (
		byTitle.find((candidate) => {
			const stem = candidate.path
				.replace(/^src\//, "")
				.replace(/\.py$/, "")
				.split("/")
				.at(-1);
			return stem === moduleName;
		}) ?? byTitle[0]
	);
}
