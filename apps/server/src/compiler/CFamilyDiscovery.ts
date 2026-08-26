import type { AppDiagnostic, TestCase } from "@ziglive/protocol";

type ProjectDiagnostic = AppDiagnostic & { path?: string };

interface SourceFile {
	path: string;
	source: string;
}

const TEST_FN = /^\s*void\s+(test_\w+)\s*\(\s*(?:void)?\s*\)/;

/**
 * Finds `void test_*(void)` functions in the project's `*_test.c` /
 * `*_test.cpp` files — the set the generated test main will call.
 */
export function discoverCFamilyTests(
	files: readonly SourceFile[],
	testFile: RegExp,
): TestCase[] {
	const tests: TestCase[] = [];
	for (const file of files) {
		if (!testFile.test(file.path)) continue;
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

const CLANG_DIAGNOSTIC =
	/^(.+?\.(?:c|h|cpp|cc|hpp)):(\d+):(\d+): (error|warning|fatal error): (.+)$/;

function clangProjectPath(file: string): string | undefined {
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

/** Parses clang stderr (`file:line:col: error: message`), dropping notes. */
export function parseClangDiagnostics(stderr: string): ProjectDiagnostic[] {
	const diagnostics: ProjectDiagnostic[] = [];
	for (const line of stderr.split("\n")) {
		const match = CLANG_DIAGNOSTIC.exec(line.trim());
		if (!match?.[1] || !match[2] || !match[3] || !match[5]) continue;
		const path = clangProjectPath(match[1]);
		diagnostics.push({
			...(path ? { path } : {}),
			message: match[5],
			severity: match[4] === "warning" ? "warning" : "error",
			line: Number(match[2]),
			column: Number(match[3]),
			source: "clang",
		});
	}
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.path ?? ""}:${diagnostic.line}:${diagnostic.column}:${diagnostic.severity}:${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Generates the test main translation unit: declares every discovered test,
 * runs them sequentially with monotonic timing, and reports the same fd 3
 * NDJSON schema as the Zig custom runner. An assert() failure aborts the
 * process; the server marks the started-but-unfinished test as failed from
 * the correlated stderr.
 */
export function buildCFamilyTestMain(
	tests: readonly TestCase[],
	language: "c" | "cpp",
): string {
	const declarations = tests
		.map((test) =>
			language === "c"
				? `void ${test.name}(void);`
				: `void ${test.name}();`,
		)
		.join("\n");
	const entries = tests
		.map((test) => `\t{"${test.name}", ${test.name}},`)
		.join("\n");
	return `#define _POSIX_C_SOURCE 199309L
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

${declarations}

struct __ziglive_test {
	const char *name;
	void (*fn)(void);
};

static struct __ziglive_test __ziglive_tests[] = {
${entries}
};

static void __ziglive_write(const char *record) {
	ssize_t written = write(3, record, strlen(record));
	(void)written;
}

static long long __ziglive_now(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

int main(void) {
	char record[512];
	int total = (int)(sizeof __ziglive_tests / sizeof __ziglive_tests[0]);
	int passed = 0;
	for (int index = 0; index < total; index++) {
		snprintf(record, sizeof record,
			"{\\"protocolVersion\\":1,\\"kind\\":\\"test_start\\",\\"index\\":%d,\\"name\\":\\"%s\\"}\\n",
			index, __ziglive_tests[index].name);
		__ziglive_write(record);
		long long started = __ziglive_now();
		__ziglive_tests[index].fn();
		long long elapsed = __ziglive_now() - started;
		snprintf(record, sizeof record,
			"{\\"protocolVersion\\":1,\\"kind\\":\\"test_result\\",\\"index\\":%d,\\"status\\":\\"passed\\",\\"durationNs\\":%lld,\\"name\\":\\"%s\\"}\\n",
			index, elapsed, __ziglive_tests[index].name);
		__ziglive_write(record);
		passed++;
	}
	snprintf(record, sizeof record,
		"{\\"protocolVersion\\":1,\\"kind\\":\\"test_summary\\",\\"passed\\":%d,\\"failed\\":0,\\"skipped\\":0,\\"leaked\\":0}\\n",
		passed);
	__ziglive_write(record);
	return 0;
}
`;
}
