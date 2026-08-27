// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorContextMenu, TreeContextMenu } from "./ContextMenus.js";

afterEach(cleanup);

function renderTreeMenu(menu: { x: number; y: number; path?: string; folder?: string }) {
	const handlers = {
		onClose: vi.fn(),
		onOpen: vi.fn(),
		onRename: vi.fn(),
		onDelete: vi.fn(),
		onCreateFile: vi.fn(),
		onCreateFolder: vi.fn(),
	};
	render(<TreeContextMenu menu={menu} {...handlers} />);
	return handlers;
}

describe("TreeContextMenu", () => {
	it("offers open/rename/delete on a file row and closes after acting", () => {
		const handlers = renderTreeMenu({ x: 10, y: 10, path: "utils/helper.zig" });
		fireEvent.click(screen.getByText("Open"));
		expect(handlers.onOpen).toHaveBeenCalledWith("utils/helper.zig");
		expect(handlers.onClose).toHaveBeenCalled();
		fireEvent.click(screen.getByText("Rename"));
		expect(handlers.onRename).toHaveBeenCalledWith("utils/helper.zig");
	});

	it("protects entry files from rename and delete", () => {
		renderTreeMenu({ x: 0, y: 0, path: "main.zig" });
		expect(
			(screen.getByText("Rename").closest("button") as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByText("Delete").closest("button") as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("creates inside the clicked folder, or the file's parent folder", () => {
		const onFolder = renderTreeMenu({ x: 0, y: 0, folder: "utils" });
		fireEvent.click(screen.getByText("New file en utils/"));
		expect(onFolder.onCreateFile).toHaveBeenCalledWith("utils/");
		cleanup();
		const onFile = renderTreeMenu({ x: 0, y: 0, path: "utils/deep/x.zig" });
		fireEvent.click(screen.getByText("New file"));
		expect(onFile.onCreateFile).toHaveBeenCalledWith("utils/deep/");
		cleanup();
		const onRoot = renderTreeMenu({ x: 0, y: 0 });
		fireEvent.click(screen.getByText("New file"));
		expect(onRoot.onCreateFile).toHaveBeenCalledWith("");
	});
});

describe("EditorContextMenu", () => {
	it("copies and pastes", () => {
		const onCopy = vi.fn();
		const onPaste = vi.fn();
		render(
			<EditorContextMenu menu={{ x: 5, y: 5 }} onCopy={onCopy} onPaste={onPaste} />,
		);
		fireEvent.click(screen.getByText("Copy"));
		fireEvent.click(screen.getByText("Paste"));
		expect(onCopy).toHaveBeenCalled();
		expect(onPaste).toHaveBeenCalled();
	});
});
