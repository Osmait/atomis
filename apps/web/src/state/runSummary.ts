import type {
	Language,
	RunResult,
	RunState,
	TestCase,
	TestResultEvent,
	TestSummaryEvent,
} from "@atomis/protocol";

/**
 * Derived run/test summaries shared by the status bar, the terminal header,
 * the tests drawer and the zen pill — plus the run-history and drawer
 * auto-open rules that fire on `run.finished`.
 */
export const RUN_STATE_LABELS: Record<RunState, string> = {
	idle: "ready",
	debouncing: "waiting",
	instrumenting: "inspecting",
	compiling: "compiling",
	running: "running",
	testing: "tests",
	succeeded: "ready",
	compile_error: "error",
	runtime_error: "error",
	timed_out: "timeout",
	cancelled: "cancelled",
};

/** Anything between an edit and run.finished, debounce included. */
export function isBusy(state: RunState): boolean {
	return [
		"debouncing",
		"instrumenting",
		"compiling",
		"running",
		"testing",
	].includes(state);
}

/** A pipeline stage is actually executing (debounce excluded). */
export function isActive(state: RunState): boolean {
	return ["instrumenting", "compiling", "running", "testing"].includes(state);
}

export const FAILING_STATUSES: ReadonlySet<TestResultEvent["status"]> = new Set(
	["failed", "leaked", "timed_out"],
);

export interface RunHistoryEntry {
	n: number;
	ok: boolean;
	ms: string;
}

/** Failing-test count per test path (`src/…`), for tree badges. */
export function computeFailsByFile(
	tests: readonly TestCase[],
	results: ReadonlyMap<string, TestResultEvent>,
): Map<string, number> {
	const fails = new Map<string, number>();
	for (const test of tests) {
		const result = results.get(test.testId);
		if (result && FAILING_STATUSES.has(result.status))
			fails.set(test.path, (fails.get(test.path) ?? 0) + 1);
	}
	return fails;
}

export function totalFails(failsByFile: ReadonlyMap<string, number>): number {
	return [...failsByFile.values()].reduce((total, count) => total + count, 0);
}

export function summaryHasFailures(summary?: TestSummaryEvent): boolean {
	return Boolean(summary && (summary.failed > 0 || summary.leaked > 0));
}

/** History entry for a finished (non-cancelled) run. */
export function finishedRunEntry(
	n: number,
	result: RunResult,
	summary?: TestSummaryEvent,
): RunHistoryEntry {
	return {
		n,
		ok:
			result.exitCode === 0 &&
			!result.timedOut &&
			(summary ? summary.failed === 0 && summary.leaked === 0 : true),
		ms: `${result.executionMs.toFixed(1)}ms`,
	};
}

/**
 * The drawer opens itself only when tests START failing; if the user closes
 * it while still red, later failing runs must not force it back open.
 */
export function shouldAutoOpenDrawer(
	summary: TestSummaryEvent | undefined,
	lastRunFailed: boolean,
): { open: boolean; failed: boolean } {
	const failed = summaryHasFailures(summary);
	return { open: failed && !lastRunFailed, failed };
}

export function stageLabel(runState: RunState, activePath: string): string {
	return runState === "instrumenting"
		? "instrumenting…"
		: runState === "compiling"
			? `compiling ${activePath}…`
			: runState === "testing"
				? "running tests…"
				: "running…";
}

export function zenStatusLabel(options: {
	active: boolean;
	runState: RunState;
	result?: RunResult;
	testSummary?: TestSummaryEvent;
	failingCount: number;
	testCount: number;
}): string {
	if (options.active) return "running…";
	if (options.result === undefined) return RUN_STATE_LABELS[options.runState];
	if (options.testSummary)
		return options.failingCount
			? `${options.failingCount} test${options.failingCount === 1 ? "" : "s"} failing`
			: `${options.testSummary.passed}/${options.testCount} tests ok · ${options.result.executionMs.toFixed(1)}ms`;
	return options.result.exitCode === 0
		? `✓ ok · ${options.result.executionMs.toFixed(1)}ms`
		: "✗ error";
}

/** Design semantics: non-failing over total (skips count toward the left). */
export function drawerScoreLabel(options: {
	testCount: number;
	testsDone: boolean;
	failingCount: number;
}): string {
	if (!options.testCount) return "0";
	return `${options.testsDone ? options.testCount - options.failingCount : "—"}/${options.testCount}`;
}

export function drawerSubLabel(options: {
	testCount: number;
	testsDone: boolean;
	busy: boolean;
	failingCount: number;
	executionMs?: number;
}): string {
	const suffix =
		options.executionMs === undefined
			? ""
			: ` · ${options.executionMs.toFixed(1)}ms`;
	if (!options.testCount) return "this run has no tests";
	if (!options.testsDone) return options.busy ? "running…" : "not run yet";
	return options.failingCount
		? `${options.failingCount} failing${suffix}`
		: `all passing${suffix}`;
}

export function termTone(options: {
	active: boolean;
	result?: RunResult;
	failingCount: number;
}): string {
	if (options.active) return "busy";
	if (options.result === undefined) return "";
	return options.result.exitCode === 0 && !options.failingCount ? "ok" : "err";
}

export function testsTone(options: {
	testsDone: boolean;
	testCount: number;
	failingCount: number;
}): string {
	if (!options.testsDone || !options.testCount) return "";
	return options.failingCount ? "err" : "ok";
}

export function zenTone(options: {
	active: boolean;
	result?: RunResult;
	failingCount: number;
}): string {
	if (options.active) return "busy";
	if (options.result === undefined) return "idle";
	return options.result.exitCode === 0 && !options.failingCount ? "ok" : "err";
}

export function caseTone(
	testsDone: boolean,
	result?: TestResultEvent,
): string {
	if (!testsDone || !result) return "";
	return FAILING_STATUSES.has(result.status) ? "err" : "ok";
}

/** Per-language copy for the drawer's hint row: [with tests, empty]. */
export const TEST_HINTS: Record<Language, [string, string]> = {
	zig: [
		'come from the file\'s test "…" blocks',
		'write test "name" { … } and it shows up here',
	],
	rust: [
		"come from the file's #[test] fns",
		"write #[test] fn name() { … } and it shows up here",
	],
	go: [
		"come from func TestXxx in *_test.go",
		"write func TestName(t *testing.T) { … } in a *_test.go",
	],
	ts: [
		"come from test()/it() in *.test.ts",
		"write test('name', () => { … }) in a *.test.ts",
	],
	py: [
		"come from def test_* in test_*.py",
		"write def test_name(): … in a test_*.py",
	],
	c: [
		"come from void test_*(void) in *_test.c",
		"write void test_name(void) { … } in a *_test.c",
	],
	cpp: [
		"come from void test_*() in *_test.cpp",
		"write void test_name() { … } in a *_test.cpp",
	],
};
