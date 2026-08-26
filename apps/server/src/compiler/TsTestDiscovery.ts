import type { AppDiagnostic, TestCase } from "@ziglive/protocol";

type ProjectDiagnostic = AppDiagnostic & { path?: string };

interface SourceFile {
	path: string;
	source: string;
}

export const TS_TEST_FILE = /\.test\.(ts|js|mjs)$/;
const TEST_CALL =
	/^\s*(?:test|it)\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/;

/**
 * Finds `test("…")` / `it("…")` calls in the project's `*.test.ts|js`
 * files — the same files the runner hands to `node --test`.
 */
export function discoverTsTests(files: readonly SourceFile[]): TestCase[] {
	const tests: TestCase[] = [];
	for (const file of files) {
		if (!TS_TEST_FILE.test(file.path)) continue;
		const lines = file.source.split("\n");
		for (const [index, line] of lines.entries()) {
			const match = TEST_CALL.exec(line);
			if (!match?.[1]) continue;
			const raw = match[1];
			const name = raw
				.slice(1, -1)
				.replace(/\\(.)/g, "$1");
			tests.push({
				testId: `${file.path}:${index + 1}`,
				path: `src/${file.path}`,
				name,
				line: index + 1,
				column: (/^\s*/.exec(line)?.[0]?.length ?? 0) + 1,
			});
		}
	}
	return tests;
}

export interface TapResult {
	name: string;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	message?: string;
}

const TAP_RESULT = /^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO).*)?$/;

/**
 * Parses node's `--test-reporter=tap` output: top-level `ok`/`not ok` lines
 * followed by an indented YAML block carrying `duration_ms` and, for
 * failures, an `error: |-` message.
 */
export function parseTapOutput(stdout: string): TapResult[] {
	const results: TapResult[] = [];
	const lines = stdout.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = TAP_RESULT.exec(lines[index] ?? "");
		if (!match?.[2]) continue;
		const status = match[3]
			? ("skipped" as const)
			: match[1]
				? ("failed" as const)
				: ("passed" as const);
		let durationMs = 0;
		let message: string | undefined;
		for (
			let cursor = index + 1;
			cursor < lines.length;
			cursor++
		) {
			const line = lines[cursor] ?? "";
			if (!line.startsWith("  ")) break;
			if (line.trim() === "...") break;
			const duration = /^\s*duration_ms:\s*([\d.]+)/.exec(line);
			if (duration?.[1]) durationMs = Number(duration[1]);
			if (/^\s*error: \|-?$/.test(line)) {
				const indent = (/^\s*/.exec(line)?.[0]?.length ?? 0) + 2;
				const collected: string[] = [];
				for (
					let body = cursor + 1;
					body < lines.length;
					body++
				) {
					const bodyLine = lines[body] ?? "";
					if (bodyLine.trim() === "" && collected.length) {
						collected.push("");
						continue;
					}
					if ((/^\s*/.exec(bodyLine)?.[0]?.length ?? 0) < indent) break;
					collected.push(bodyLine.slice(indent));
				}
				message = collected.join("\n").trim().slice(0, 1200);
			}
		}
		results.push({
			name: match[2],
			status,
			durationMs,
			...(status === "failed" && message ? { message } : {}),
		});
	}
	return results;
}

const TSC_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$/;

/**
 * Parses `tsc --noEmit --pretty false` output (`src/x.ts(4,7): error TSnnnn:
 * message`) into project diagnostics. Type errors never block the run — they
 * surface as diagnostics only, matching the language's runtime semantics.
 */
export function parseTscDiagnostics(stdout: string): ProjectDiagnostic[] {
	const diagnostics: ProjectDiagnostic[] = [];
	for (const line of stdout.split("\n")) {
		const match = TSC_DIAGNOSTIC.exec(line.trim());
		if (!match?.[1] || !match[2] || !match[3] || !match[5]) continue;
		let normalized = match[1].replaceAll("\\", "/");
		const marker = normalized.lastIndexOf("/src/");
		if (marker >= 0) normalized = normalized.slice(marker + 1);
		if (!normalized.startsWith("src/")) continue;
		diagnostics.push({
			path: normalized,
			message: match[5],
			severity: match[4] === "warning" ? "warning" : "error",
			line: Number(match[2]),
			column: Number(match[3]),
			source: "tsc",
		});
	}
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.path ?? ""}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
