import type {
	RunResult,
	TestCase,
	TestResultEvent,
	TestSummaryEvent,
} from "@atomis/protocol";
import { describe, expect, it } from "vitest";
import {
	computeFailsByFile,
	drawerScoreLabel,
	drawerSubLabel,
	finishedRunEntry,
	shouldAutoOpenDrawer,
	termTone,
	totalFails,
	zenStatusLabel,
} from "./runSummary.js";

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
	exitCode: 0,
	signal: null,
	timedOut: false,
	cancelled: false,
	instrumentationMs: 1,
	compilationMs: 10,
	executionMs: 5.25,
	...overrides,
});

const summary = (overrides: Partial<TestSummaryEvent> = {}): TestSummaryEvent =>
	({
		passed: 2,
		failed: 0,
		skipped: 0,
		leaked: 0,
		...overrides,
	}) as TestSummaryEvent;

const test = (testId: string, path: string): TestCase =>
	({ testId, name: testId, path, line: 1, column: 1 }) as TestCase;

const testResult = (status: TestResultEvent["status"]): TestResultEvent =>
	({ status }) as TestResultEvent;

describe("computeFailsByFile", () => {
	it("counts failing/leaked/timed_out per file", () => {
		const fails = computeFailsByFile(
			[test("a", "src/x.zig"), test("b", "src/x.zig"), test("c", "src/y.zig")],
			new Map([
				["a", testResult("failed")],
				["b", testResult("leaked")],
				["c", testResult("passed")],
			]),
		);
		expect(fails.get("src/x.zig")).toBe(2);
		expect(fails.has("src/y.zig")).toBe(false);
		expect(totalFails(fails)).toBe(2);
	});
});

describe("finishedRunEntry", () => {
	it("is ok only with exit 0, no timeout, and green tests", () => {
		expect(finishedRunEntry(1, result()).ok).toBe(true);
		expect(finishedRunEntry(1, result({ exitCode: 1 })).ok).toBe(false);
		expect(finishedRunEntry(1, result({ timedOut: true })).ok).toBe(false);
		expect(finishedRunEntry(1, result(), summary({ failed: 1 })).ok).toBe(false);
		expect(finishedRunEntry(1, result(), summary({ leaked: 1 })).ok).toBe(false);
		expect(finishedRunEntry(2, result()).ms).toBe("5.3ms");
	});
});

describe("shouldAutoOpenDrawer", () => {
	it("opens only when tests START failing", () => {
		expect(shouldAutoOpenDrawer(summary({ failed: 1 }), false)).toEqual({
			open: true,
			failed: true,
		});
		// The regression this rule fixed: the user closed the drawer while
		// red, so the next failing run must not force it back open.
		expect(shouldAutoOpenDrawer(summary({ failed: 1 }), true)).toEqual({
			open: false,
			failed: true,
		});
		expect(shouldAutoOpenDrawer(summary(), true)).toEqual({
			open: false,
			failed: false,
		});
		expect(shouldAutoOpenDrawer(undefined, false).open).toBe(false);
	});
});

describe("labels", () => {
	it("scores the drawer with non-failing over total", () => {
		expect(
			drawerScoreLabel({ testCount: 3, testsDone: true, failingCount: 1 }),
		).toBe("2/3");
		expect(
			drawerScoreLabel({ testCount: 3, testsDone: false, failingCount: 0 }),
		).toBe("—/3");
		expect(
			drawerScoreLabel({ testCount: 0, testsDone: false, failingCount: 0 }),
		).toBe("0");
	});

	it("describes the drawer state", () => {
		expect(
			drawerSubLabel({
				testCount: 0,
				testsDone: false,
				busy: false,
				failingCount: 0,
			}),
		).toBe("esta ejecución no tiene tests");
		expect(
			drawerSubLabel({
				testCount: 2,
				testsDone: true,
				busy: false,
				failingCount: 0,
				executionMs: 5.25,
			}),
		).toBe("todos pasando · 5.3ms");
	});

	it("summarizes the zen pill", () => {
		expect(
			zenStatusLabel({
				active: false,
				runState: "succeeded",
				result: result(),
				testSummary: summary(),
				failingCount: 0,
				testCount: 2,
			}),
		).toBe("2/2 tests ok · 5.3ms");
	});

	it("tones the terminal dot", () => {
		expect(termTone({ active: true, failingCount: 0 })).toBe("busy");
		expect(termTone({ active: false, result: result(), failingCount: 0 })).toBe(
			"ok",
		);
		expect(termTone({ active: false, result: result(), failingCount: 1 })).toBe(
			"err",
		);
	});
});
