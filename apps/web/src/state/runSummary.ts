import type {
	Language,
	RunResult,
	RunState,
	TestCase,
	TestResultEvent,
	TestSummaryEvent,
} from "@ziglive/protocol";

/**
 * Derived run/test summaries shared by the status bar, the terminal header,
 * the tests drawer and the zen pill — plus the run-history and drawer
 * auto-open rules that fire on `run.finished`.
 */
export const RUN_STATE_LABELS: Record<RunState, string> = {
	idle: "listo",
	debouncing: "esperando",
	instrumenting: "inspeccionando",
	compiling: "compilando",
	running: "ejecutando",
	testing: "tests",
	succeeded: "listo",
	compile_error: "error",
	runtime_error: "error",
	timed_out: "timeout",
	cancelled: "cancelado",
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
		? "instrumentando…"
		: runState === "compiling"
			? `compilando ${activePath}…`
			: runState === "testing"
				? "ejecutando tests…"
				: "ejecutando…";
}

export function zenStatusLabel(options: {
	active: boolean;
	runState: RunState;
	result?: RunResult;
	testSummary?: TestSummaryEvent;
	failingCount: number;
	testCount: number;
}): string {
	if (options.active) return "ejecutando…";
	if (options.result === undefined) return RUN_STATE_LABELS[options.runState];
	if (options.testSummary)
		return options.failingCount
			? `${options.failingCount} test${options.failingCount === 1 ? "" : "s"} fallando`
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
	if (!options.testCount) return "esta ejecución no tiene tests";
	if (!options.testsDone) return options.busy ? "corriendo…" : "sin ejecutar";
	return options.failingCount
		? `${options.failingCount} fallando${suffix}`
		: `todos pasando${suffix}`;
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
		'salen de los bloques test "…" del archivo',
		'escribe test "nombre" { … } y aparecerá aquí',
	],
	rust: [
		"salen de las fn con #[test] del archivo",
		"escribe #[test] fn nombre() { … } y aparecerá aquí",
	],
	go: [
		"salen de las func TestXxx de *_test.go",
		"escribe func TestNombre(t *testing.T) { … } en un *_test.go",
	],
	ts: [
		"salen de los test()/it() de *.test.ts",
		"escribe test('nombre', () => { … }) en un *.test.ts",
	],
	py: [
		"salen de las def test_* de test_*.py",
		"escribe def test_nombre(): … en un test_*.py",
	],
	c: [
		"salen de las void test_*(void) de *_test.c",
		"escribe void test_nombre(void) { … } en un *_test.c",
	],
	cpp: [
		"salen de las void test_*() de *_test.cpp",
		"escribe void test_nombre() { … } en un *_test.cpp",
	],
};
