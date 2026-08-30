// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupOutput } from "../shared/lib/terminalFolds.js";
import type { TerminalEntry } from "../types.js";
import { Terminal } from "./Terminal.js";

afterEach(cleanup);

const entry = (
	chunk: string,
	receivedAt: number,
	line?: number,
): TerminalEntry => ({
	stream: "stdout",
	category: "program",
	chunk,
	receivedAt,
	...(line !== undefined
		? {
				sourceLocation: {
					path: "src/main.zig",
					line,
					column: 5,
					executionIndex: 1,
				},
			}
		: {}),
});

function renderTerminal(
	overrides: Partial<React.ComponentProps<typeof Terminal>> = {},
) {
	const handlers = {
		onTab: vi.fn(),
		onDock: vi.fn(),
		onToggleMax: vi.fn(),
		onToggleDrawer: vi.fn(),
		onOpenDrawer: vi.fn(),
		onClearOutput: vi.fn(),
		onCloseTerm: vi.fn(),
		onToggleFold: vi.fn(),
		onProblemJump: vi.fn(),
		onEntryClick: vi.fn(),
		onEntryHover: vi.fn(),
		onEntryLeave: vi.fn(),
	};
	const output = overrides.output ?? [entry("hola\n", 100, 3)];
	render(
		<Terminal
			active={false}
			allProblems={[]}
			busy={false}
			caseTone={() => ""}
			depsBusy={false}
			depsCount={0}
			depsPanel={<div data-testid="deps-stub" />}
			dockEffective="right"
			drawer={false}
			drawerScore="0"
			entryFile="main.zig"
			focused={false}
			lspLabel="zls connected"
			narrow={false}
			openFolds={new Set()}
			output={output}
			outputRows={groupOutput(output)}
			probesLabel="4 / 4"
			runCommand="zig build run"
			runStateLabel="ready"
			stageLabel="running…"
			tab="output"
			termMax={false}
			termTone="ok"
			testCommand="zig test"
			tests={[]}
			testsLabel="—"
			testsTone=""
			toolchainLabel="0.16.0"
			{...handlers}
			{...overrides}
		/>,
	);
	return handlers;
}

describe("Terminal", () => {
	it("prints the prompt and the output with provenance affordances", () => {
		const handlers = renderTerminal();
		expect(screen.getByText("zig build run")).toBeTruthy();
		const line = screen.getByText("hola", { selector: "pre" });
		expect(line.closest(".output-entry")?.className).toContain("has-source");
		fireEvent.click(line.closest(".output-entry") as HTMLElement);
		expect(handlers.onEntryClick).toHaveBeenCalledWith(
			expect.objectContaining({ line: 3 }),
		);
		fireEvent.mouseLeave(line.closest(".output-entry") as HTMLElement);
		expect(handlers.onEntryLeave).toHaveBeenCalled();
	});

	it("collapses loop traces into a fold row", () => {
		const output = [0, 1, 2, 3].map((i) => entry(`iter ${i}\n`, 100 + i, 3));
		const handlers = renderTerminal({ output, outputRows: groupOutput(output) });
		const fold = screen.getByText(/trace · src\/main\.zig:3:5/);
		expect(screen.queryByText("iter 0", { selector: "pre" })).toBeNull();
		fireEvent.click(fold.closest("button") as HTMLElement);
		expect(handlers.onToggleFold).toHaveBeenCalledWith("loop:src/main.zig:3:5:0");
	});

	it("switches views from the ⋮ menu", () => {
		const handlers = renderTerminal();
		fireEvent.click(screen.getByLabelText("Terminal options"));
		fireEvent.click(screen.getByText("Runtime"));
		expect(handlers.onTab).toHaveBeenCalledWith("runtime");
	});

	it("lists problems with their location and jumps on click", () => {
		const handlers = renderTerminal({
			tab: "problems",
			allProblems: [
				{
					owner: "compiler",
					message: "use of undeclared identifier",
					severity: "error",
					line: 7,
					column: 2,
					path: "src/main.zig",
				},
			],
		});
		fireEvent.click(screen.getByText("use of undeclared identifier"));
		expect(handlers.onProblemJump).toHaveBeenCalledWith(
			expect.objectContaining({ line: 7 }),
		);
	});

	it("shows the runtime grid values", () => {
		renderTerminal({ tab: "runtime" });
		expect(screen.getByText("4 / 4")).toBeTruthy();
		expect(screen.getByText("zls connected")).toBeTruthy();
		expect(screen.getByText("0.16.0")).toBeTruthy();
	});

	it("expands the tests bar into the drawer", () => {
		const handlers = renderTerminal();
		fireEvent.click(screen.getByTitle("Show tests (⌘T)"));
		expect(handlers.onOpenDrawer).toHaveBeenCalled();
	});

	it("renders the drawer children instead of the bar when open", () => {
		renderTerminal({
			drawer: true,
			children: <div data-testid="drawer-stub" />,
		});
		expect(screen.getByTestId("drawer-stub")).toBeTruthy();
		expect(screen.queryByTitle("Show tests (⌘T)")).toBeNull();
	});
});
