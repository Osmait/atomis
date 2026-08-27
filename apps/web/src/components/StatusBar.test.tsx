// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar.js";

afterEach(cleanup);

function renderBar(
	overrides: Partial<React.ComponentProps<typeof StatusBar>> = {},
) {
	render(
		<StatusBar
			activePath="main.zig"
			cursor={{ line: 4, column: 7 }}
			degradedMessages={[]}
			focusZone="editor"
			leaderPending={false}
			runState="succeeded"
			timingLabel="zig · utf-8"
			valuesCount={3}
			vimModeLabel="NORMAL"
			vimStatusRef={createRef<HTMLDivElement>()}
			{...overrides}
		/>,
	);
}

describe("StatusBar", () => {
	it("shows the vim mode, path, values and cursor", () => {
		renderBar();
		expect(screen.getByText("NORMAL").className).toContain("mode-normal");
		expect(screen.getByText("src/main.zig")).toBeTruthy();
		expect(screen.getByText("+3")).toBeTruthy();
		expect(screen.getByText("4:7")).toBeTruthy();
		expect(screen.getByText("listo").className).toContain("state-succeeded");
	});

	it("prioritizes LEADER over the zone and the zone over vim", () => {
		renderBar({ leaderPending: true, focusZone: "tree" });
		expect(screen.getByText("LEADER").className).toContain("mode-zone");
		cleanup();
		renderBar({ focusZone: "tree" });
		expect(screen.getByText("ÁRBOL")).toBeTruthy();
		cleanup();
		renderBar({ focusZone: "term" });
		expect(screen.getByText("TERMINAL")).toBeTruthy();
	});

	it("surfaces degraded toolchain messages", () => {
		renderBar({
			degradedMessages: ["rust: cargo no encontrado", "rust-analyzer ausente"],
		});
		expect(
			screen.getByText("rust: cargo no encontrado · rust-analyzer ausente"),
		).toBeTruthy();
	});
});
