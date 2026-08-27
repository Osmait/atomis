// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TestCase, TestResultEvent } from "@atomis/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestsDrawer } from "./TestsDrawer.js";

afterEach(cleanup);

const tests = [
	{ testId: "src/main.zig:3", name: "suma", path: "src/main.zig", line: 3, column: 1 },
	{ testId: "src/main.zig:9", name: "resta", path: "src/main.zig", line: 9, column: 1 },
] as TestCase[];

const results = new Map<string, TestResultEvent>([
	[
		"src/main.zig:3",
		{
			status: "passed",
			name: "suma",
			testId: "src/main.zig:3",
			durationMs: 1.2,
		} as TestResultEvent,
	],
	[
		"src/main.zig:9",
		{
			status: "failed",
			name: "resta",
			testId: "src/main.zig:9",
			durationMs: 0.4,
			message: "expected 4, found 5",
		} as TestResultEvent,
	],
]);

function renderDrawer(
	overrides: Partial<React.ComponentProps<typeof TestsDrawer>> = {},
) {
	const handlers = {
		onClose: vi.fn(),
		onDrawerTab: vi.fn(),
		onJump: vi.fn(),
		onRun: vi.fn(),
	};
	render(
		<TestsDrawer
			caseTone={() => ""}
			drawerScore="1/2"
			drawerSub="1 fallando · 5.0ms"
			drawerTab="tests"
			hintEmpty="sin tests"
			hintSource="salen del archivo"
			history={[{ n: 2, ok: false, ms: "5.0ms" }, { n: 1, ok: true, ms: "4.1ms" }]}
			testResults={results}
			tests={tests}
			testsTone="err"
			{...handlers}
			{...overrides}
		/>,
	);
	return handlers;
}

describe("TestsDrawer", () => {
	it("shows the score, the subtitle and one row per test", () => {
		renderDrawer();
		expect(screen.getByText("1/2")).toBeTruthy();
		expect(screen.getByText("1 fallando · 5.0ms")).toBeTruthy();
		expect(screen.getByText("suma")).toBeTruthy();
		expect(screen.getByText("1.2ms")).toBeTruthy();
	});

	it("expands failing tests with their message and actions", () => {
		const handlers = renderDrawer();
		expect(screen.getByText("expected 4, found 5")).toBeTruthy();
		fireEvent.click(screen.getByText("ir a L9"));
		expect(handlers.onJump).toHaveBeenCalledWith(tests[1]);
		fireEvent.click(screen.getByText("correr tests"));
		expect(handlers.onRun).toHaveBeenCalled();
	});

	it("switches to the run history tab", () => {
		const handlers = renderDrawer();
		fireEvent.click(screen.getByText("Historial"));
		expect(handlers.onDrawerTab).toHaveBeenCalledWith("hist");
	});

	it("lists past runs under Historial", () => {
		renderDrawer({ drawerTab: "hist" });
		expect(screen.getByText("#2").className).toBe("err");
		expect(screen.getByText("#1").className).toBe("ok");
	});

	it("hints how to write tests when there are none", () => {
		renderDrawer({ tests: [], testResults: new Map(), drawerSub: "" });
		expect(screen.getByText("sin tests")).toBeTruthy();
	});
});
