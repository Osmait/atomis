// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeRow } from "../state/fileTree.js";
import { FileTree } from "./FileTree.js";

afterEach(cleanup);

const rows: TreeRow[] = [
	{
		kind: "folder",
		path: "utils",
		name: "utils",
		depth: 0,
		collapsed: false,
		fails: 2,
		pending: false,
	},
	{ kind: "file", path: "utils/helper.zig", name: "helper.zig", depth: 1 },
	{ kind: "file", path: "main.zig", name: "main.zig", depth: 0 },
];

function renderTree(
	overrides: Partial<React.ComponentProps<typeof FileTree>> = {},
) {
	const handlers = {
		onToggleSrc: vi.fn(),
		onSelect: vi.fn(),
		onToggleFolder: vi.fn(),
		onCreateFile: vi.fn(),
		onCreateFolder: vi.fn(),
		onRenameActive: vi.fn(),
		onDeleteActive: vi.fn(),
		onHideTree: vi.fn(),
		onLoadDemo: vi.fn(),
		onSwitchWorkspace: vi.fn(),
		onClearWorkspace: vi.fn(),
		onDraftChange: vi.fn(),
		onDraftCommit: vi.fn(),
		onDraftCancel: vi.fn(),
		onOpenContextMenu: vi.fn(),
	};
	render(
		<FileTree
			activeIsEntry={true}
			activePath="main.zig"
			draft={undefined}
			draftInvalid={false}
			draftValue=""
			failsByFile={new Map([["src/utils/helper.zig", 2]])}
			focused={false}
			revealKey="test"
			scratch={false}
			workspaceName="AoC 2026"
			rows={rows}
			srcCollapsed={false}
			treeSel={0}
			{...handlers}
			{...overrides}
		/>,
	);
	return handlers;
}

describe("FileTree", () => {
	it("renders folders with failing badges and files with their fails", () => {
		renderTree();
		expect(screen.getByTitle("utils")).toBeTruthy();
		// Both the folder and the failing file inside it show the count.
		expect(
			screen.getAllByText("2", { selector: ".tree-badge.fails" }),
		).toHaveLength(2);
		expect(screen.getByLabelText("main.zig").className).toContain("active");
	});

	it("selects a file and toggles a folder on click", () => {
		const handlers = renderTree();
		fireEvent.click(screen.getByLabelText("utils/helper.zig"));
		expect(handlers.onSelect).toHaveBeenCalledWith("utils/helper.zig");
		fireEvent.click(screen.getByTitle("utils"));
		expect(handlers.onToggleFolder).toHaveBeenCalledWith("utils");
	});

	it("hides every row while src is collapsed", () => {
		renderTree({ srcCollapsed: true });
		expect(screen.queryByLabelText("main.zig")).toBeNull();
	});

	it("opens the ⋯ menu with rename/delete disabled on the entry file", () => {
		const handlers = renderTree();
		fireEvent.click(screen.getByLabelText("Tree actions"));
		const rename = screen
			.getByText("Rename file")
			.closest("button") as HTMLButtonElement;
		expect(rename.disabled).toBe(true);
		fireEvent.click(screen.getByText("New file"));
		expect(handlers.onCreateFile).toHaveBeenCalledWith();
	});

	it("offers demo and clear workspace actions in the menu", () => {
		const handlers = renderTree();
		fireEvent.click(screen.getByLabelText("Tree actions"));
		fireEvent.click(screen.getByText("Load demo workspace"));
		expect(handlers.onLoadDemo).toHaveBeenCalled();
		fireEvent.click(screen.getByLabelText("Tree actions"));
		fireEvent.click(screen.getByText("Clear workspace"));
		expect(handlers.onClearWorkspace).toHaveBeenCalled();
	});

	it("commits the inline draft with Enter and cancels with Escape", () => {
		const handlers = renderTree({
			draft: { kind: "file", base: "" },
			draftValue: "nuevo.zig",
		});
		const input = screen.getByLabelText("File name");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(handlers.onDraftCommit).toHaveBeenCalledWith("nuevo.zig");
		fireEvent.keyDown(input, { key: "Escape" });
		expect(handlers.onDraftCancel).toHaveBeenCalled();
	});

	it("marks the keyboard selection while the tree zone is focused", () => {
		renderTree({ focused: true, treeSel: 2 });
		expect(screen.getByLabelText("main.zig").className).toContain("kb-sel");
	});

	it("reports the right-clicked row to the context menu", () => {
		const handlers = renderTree();
		fireEvent.contextMenu(screen.getByLabelText("utils/helper.zig"));
		expect(handlers.onOpenContextMenu).toHaveBeenCalledWith(
			expect.objectContaining({ path: "utils/helper.zig" }),
		);
	});
});
