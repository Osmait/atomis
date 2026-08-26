import { describe, expect, it, vi } from "vitest";
import { RunScheduler } from "./RunScheduler.js";

describe("RunScheduler", () => {
	it("debounces and cancels superseded work", async () => {
		vi.useFakeTimers();
		const events: unknown[] = [];
		const session = {
			id: "x",
			language: "zig",
			settings: {
				autoRun: true,
				autoInspect: true,
				debounceMs: 400,
				timeoutMs: 2000,
				manualProbeIds: [],
			},
			store: { current: () => ({ version: 2 }) },
		} as never;
		const run = vi.fn(async () => ({
			terminalState: "succeeded" as const,
			result: {
				instrumentationMs: 1,
				compilationMs: 1,
				executionMs: 1,
				exitCode: 0,
				signal: null,
				timedOut: false,
				cancelled: false,
			},
		}));
		const scheduler = new RunScheduler(
			session,
			{ zig: { run } } as never,
			(event) => events.push(event),
		);
		scheduler.documentUpdated();
		scheduler.documentUpdated();
		expect(events).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(399);
		expect(run).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});
