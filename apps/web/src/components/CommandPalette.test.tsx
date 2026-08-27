// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.js";

afterEach(cleanup);

function renderPalette(
	overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {},
) {
	const handlers = {
		onOpen: vi.fn(),
		onCreate: vi.fn(),
		onClose: vi.fn(),
	};
	const settings = vi.fn();
	render(
		<CommandPalette
			activePath="main.zig"
			commands={[
				{ id: "settings", title: "Open settings", hint: "⌘,", act: settings },
			]}
			files={[{ path: "main.zig" }, { path: "util.zig" }]}
			{...handlers}
			{...overrides}
		/>,
	);
	return { ...handlers, settings };
}

describe("CommandPalette", () => {
	it("offers the commands before any file, so settings stay reachable", () => {
		const { settings } = renderPalette();
		const rows = screen.getAllByRole("button");
		expect(rows[0]?.textContent).toContain("Open settings");
		fireEvent.click(screen.getByText("Open settings"));
		expect(settings).toHaveBeenCalled();
	});

	it("runs the selected command on Enter", () => {
		const { settings, onOpen } = renderPalette();
		const input = screen.getByRole("textbox");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(settings).toHaveBeenCalled();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("narrows to commands after > and hides the files", () => {
		renderPalette();
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: ">set" } });
		expect(screen.getByText("Open settings")).toBeTruthy();
		expect(screen.queryByText("util.zig")).toBeNull();
	});

	it("leaves the commands out when the query does not name one", () => {
		const { onOpen } = renderPalette();
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "util" } });
		expect(screen.queryByText("Open settings")).toBeNull();
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onOpen).toHaveBeenCalledWith("util.zig", false);
	});

	it("counts the command row when the arrows walk down to a file", () => {
		const { onOpen } = renderPalette();
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "set" } });
		// "Open settings" matches, and so does no file: row 0 is the command,
		// row 1 the offer to create "set".
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("offers to create a path no file matches", () => {
		const { onCreate } = renderPalette();
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "new/thing.zig" } });
		fireEvent.click(screen.getByText("create new/thing.zig"));
		expect(onCreate).toHaveBeenCalledWith("new/thing.zig");
	});
});
