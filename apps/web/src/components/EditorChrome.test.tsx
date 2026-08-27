// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorChrome } from "./EditorChrome.js";

afterEach(cleanup);

function renderChrome(
	overrides: Partial<React.ComponentProps<typeof EditorChrome>> = {},
) {
	const handlers = {
		onShowTree: vi.fn(),
		onSelect: vi.fn(),
		onCloseTab: vi.fn(),
		onOpenPalette: vi.fn(),
		onToggleAutoRun: vi.fn(),
		onOpenSettings: vi.fn(),
		onRun: vi.fn(),
		onStop: vi.fn(),
	};
	render(
		<EditorChrome
			active={false}
			activePath="main.zig"
			autoRun={true}
			openTabs={["main.zig", "util.zig"]}
			runDisabled={false}
			showTreeRestore={false}
			stale={false}
			{...handlers}
			{...overrides}
		/>,
	);
	return handlers;
}

describe("EditorChrome", () => {
	it("renders one tab per open file, marking the active one", () => {
		renderChrome();
		const tabs = screen.getAllByRole("tab");
		expect(tabs).toHaveLength(2);
		expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
		expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
	});

	it("selects on tab click but closes via ✕ without selecting", () => {
		const handlers = renderChrome();
		fireEvent.click(screen.getByText("util.zig"));
		expect(handlers.onSelect).toHaveBeenCalledWith("util.zig");
		handlers.onSelect.mockClear();
		const closes = screen.getAllByTitle("Close tab");
		fireEvent.click(closes[1] as HTMLElement);
		expect(handlers.onCloseTab).toHaveBeenCalledWith("util.zig");
		expect(handlers.onSelect).not.toHaveBeenCalled();
	});

	it("runs when idle and stops while running", () => {
		const idle = renderChrome();
		fireEvent.click(screen.getByLabelText("Run"));
		expect(idle.onRun).toHaveBeenCalled();
		cleanup();
		const running = renderChrome({ active: true });
		fireEvent.click(screen.getByLabelText("Stop"));
		expect(running.onStop).toHaveBeenCalled();
	});

	it("shows the stale dot only on the edited active tab", () => {
		renderChrome({ stale: true });
		const activeTab = screen.getAllByRole("tab")[0] as HTMLElement;
		expect(activeTab.querySelector(".stale-dot")).toBeTruthy();
	});

	it("disables run and auto while the language is degraded", () => {
		renderChrome({ runDisabled: true });
		expect((screen.getByLabelText("Run") as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByText("auto") as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});
