import type { AppDiagnostic, TestCase } from "@ziglive/protocol";

type ProjectDiagnostic = AppDiagnostic & { path?: string };

interface SourceFile {
	path: string;
	source: string;
}

const TEST_FN = /^func (Test[A-Za-z0-9_]*)\s*\(/;

/**
 * Finds `func TestXxx(` declarations in the visible `*_test.go` files, which
 * is exactly the set `go test` collects for a package.
 */
export function discoverGoTests(files: readonly SourceFile[]): TestCase[] {
	const tests: TestCase[] = [];
	for (const file of files) {
		if (!file.path.endsWith("_test.go")) continue;
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

export interface GoTestEvent {
	Action?: string;
	Test?: string;
	Elapsed?: number;
	Output?: string;
}

export interface GoTestResult {
	name: string;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	message?: string;
}

/**
 * Folds `go test -json` NDJSON events into per-test results. Output lines
 * are buffered per test; for failures the informative lines (everything but
 * the RUN/FAIL banners) become the message.
 */
export function parseGoTestEvents(stdout: string): GoTestResult[] {
	const output = new Map<string, string[]>();
	const results: GoTestResult[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		let event: GoTestEvent;
		try {
			event = JSON.parse(line) as GoTestEvent;
		} catch {
			continue;
		}
		if (!event.Test) continue;
		if (event.Action === "output" && event.Output) {
			if (!/^(=== RUN|--- (FAIL|PASS|SKIP)|=== (PAUSE|CONT))/.test(event.Output.trim()))
				output.set(event.Test, [
					...(output.get(event.Test) ?? []),
					event.Output.trimEnd(),
				]);
		} else if (
			event.Action === "pass" ||
			event.Action === "fail" ||
			event.Action === "skip"
		) {
			const status =
				event.Action === "pass"
					? ("passed" as const)
					: event.Action === "fail"
						? ("failed" as const)
						: ("skipped" as const);
			const message =
				status === "failed"
					? output
							.get(event.Test)
							?.map((item) => item.trim())
							.filter(Boolean)
							.join("\n")
							.slice(0, 1200)
					: undefined;
			results.push({
				name: event.Test,
				status,
				durationMs: (event.Elapsed ?? 0) * 1000,
				...(message ? { message } : {}),
			});
		}
	}
	return results;
}

const GO_DIAGNOSTIC = /^(?:# [^\n]+\n)?(.+?\.go):(\d+)(?::(\d+))?: (.+)$/;

function goProjectPath(file: string): string | undefined {
	const normalized = file.replaceAll("\\", "/");
	if (normalized.startsWith("generated/"))
		return `src/${normalized.slice("generated/".length)}`;
	if (normalized.startsWith("src/")) return normalized;
	const generated = normalized.lastIndexOf("/generated/");
	if (generated >= 0)
		return `src/${normalized.slice(generated + "/generated/".length)}`;
	const source = normalized.lastIndexOf("/src/");
	if (source >= 0) return normalized.slice(source + 1);
	return undefined;
}

/**
 * Parses `go build` / `go vet` style stderr (`file.go:line:col: message`)
 * into project diagnostics, mapping the generated mirror back to `src/`.
 */
export function parseGoDiagnostics(stderr: string): ProjectDiagnostic[] {
	const diagnostics: ProjectDiagnostic[] = [];
	for (const line of stderr.split("\n")) {
		if (line.startsWith("#") || !line.trim()) continue;
		const match = GO_DIAGNOSTIC.exec(line.trim());
		if (!match?.[1] || !match[2] || !match[4]) continue;
		const path = goProjectPath(match[1]);
		diagnostics.push({
			...(path ? { path } : {}),
			message: match[4],
			severity: "error",
			line: Number(match[2]),
			column: Number(match[3] ?? 1),
			source: "go",
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
