import { describe, expect, it } from "vitest";
import {
	moveTreeSelection,
	resolveNavAction,
	type NavKeyContext,
} from "./keyboardNav.js";

function context(overrides: Partial<NavKeyContext>): NavKeyContext {
	return {
		key: "",
		hasModifier: false,
		inMonaco: false,
		inTextInput: false,
		overlayOpen: false,
		leaderPending: false,
		leaderChar: " ",
		vimAllows: true,
		zone: "editor",
		termOpen: true,
		tabCount: 1,
		...overrides,
	};
}

describe("resolveNavAction", () => {
	it("ignores keys with modifiers, inside inputs, or under overlays", () => {
		expect(resolveNavAction(context({ key: " ", hasModifier: true }))).toBeUndefined();
		expect(resolveNavAction(context({ key: " ", inTextInput: true }))).toBeUndefined();
		expect(resolveNavAction(context({ key: " ", overlayOpen: true }))).toBeUndefined();
	});

	it("starts the leader only from vim NORMAL inside Monaco", () => {
		expect(resolveNavAction(context({ key: " " }))).toEqual({ kind: "leader-start" });
		expect(
			resolveNavAction(context({ key: " ", inMonaco: true, vimAllows: false })),
		).toBeUndefined();
		expect(
			resolveNavAction(context({ key: " ", inMonaco: true, vimAllows: true })),
		).toEqual({ kind: "leader-start" });
	});

	it("leader+e toggles the tree: focus it, close it when already focused", () => {
		expect(
			resolveNavAction(context({ key: "e", leaderPending: true })),
		).toEqual({ kind: "focus-tree" });
		expect(
			resolveNavAction(context({ key: "e", leaderPending: true, zone: "tree" })),
		).toEqual({ kind: "hide-tree" });
	});

	it("leader+t opens, focuses or hides the terminal", () => {
		expect(
			resolveNavAction(
				context({ key: "t", leaderPending: true, termOpen: false }),
			),
		).toEqual({ kind: "focus-term" });
		expect(
			resolveNavAction(context({ key: "t", leaderPending: true, zone: "term" })),
		).toEqual({ kind: "hide-term" });
	});

	it("leader+h/l move across panels and stop at the edges", () => {
		expect(
			resolveNavAction(context({ key: "h", leaderPending: true, zone: "term" })),
		).toEqual({ kind: "focus-editor" });
		expect(
			resolveNavAction(context({ key: "h", leaderPending: true })),
		).toEqual({ kind: "focus-tree" });
		expect(
			resolveNavAction(context({ key: "h", leaderPending: true, zone: "tree" })),
		).toEqual({ kind: "noop" });
		expect(
			resolveNavAction(context({ key: "l", leaderPending: true, zone: "tree" })),
		).toEqual({ kind: "focus-editor" });
		expect(
			resolveNavAction(context({ key: "l", leaderPending: true, zone: "term" })),
		).toEqual({ kind: "noop" });
	});

	it("leader+o closes the other tabs; unbound keys just cancel", () => {
		expect(
			resolveNavAction(context({ key: "o", leaderPending: true })),
		).toEqual({ kind: "close-other-tabs" });
		expect(
			resolveNavAction(context({ key: "x", leaderPending: true })),
		).toEqual({ kind: "leader-cancel" });
	});

	it("Shift+H/L cycle tabs only with several tabs and vim NORMAL", () => {
		expect(
			resolveNavAction(context({ key: "L", tabCount: 3 })),
		).toEqual({ kind: "cycle-tab", direction: 1 });
		expect(
			resolveNavAction(context({ key: "H", tabCount: 3 })),
		).toEqual({ kind: "cycle-tab", direction: -1 });
		expect(resolveNavAction(context({ key: "L", tabCount: 1 }))).toBeUndefined();
		expect(
			resolveNavAction(
				context({ key: "L", tabCount: 3, inMonaco: true, vimAllows: false }),
			),
		).toBeUndefined();
	});

	it("navigates the tree with j/k and opens rows with Enter/l", () => {
		const tree = { zone: "tree" as const };
		expect(resolveNavAction(context({ ...tree, key: "j" }))).toEqual({
			kind: "tree-move",
			delta: 1,
		});
		expect(
			resolveNavAction(
				context({ ...tree, key: "Enter", treeSelected: { kind: "file" } }),
			),
		).toEqual({ kind: "tree-open-file", focusEditor: true });
		expect(
			resolveNavAction(
				context({ ...tree, key: "l", treeSelected: { kind: "file" } }),
			),
		).toEqual({ kind: "tree-open-file", focusEditor: false });
		expect(
			resolveNavAction(
				context({
					...tree,
					key: "l",
					treeSelected: { kind: "folder", collapsed: true },
				}),
			),
		).toEqual({ kind: "tree-toggle-folder" });
		expect(
			resolveNavAction(
				context({
					...tree,
					key: "l",
					treeSelected: { kind: "folder", collapsed: false },
				}),
			),
		).toEqual({ kind: "noop" });
		expect(
			resolveNavAction(
				context({
					...tree,
					key: "h",
					treeSelected: { kind: "folder", collapsed: false },
				}),
			),
		).toEqual({ kind: "tree-toggle-folder" });
		expect(resolveNavAction(context({ ...tree, key: "Escape" }))).toEqual({
			kind: "focus-editor",
		});
	});

	it("scrolls the terminal with j/k/d/u/G", () => {
		const term = { zone: "term" as const };
		expect(resolveNavAction(context({ ...term, key: "d" }))).toEqual({
			kind: "term-scroll",
			amount: "half",
			direction: 1,
		});
		expect(resolveNavAction(context({ ...term, key: "G" }))).toEqual({
			kind: "term-bottom",
		});
		expect(resolveNavAction(context({ ...term, key: "Escape" }))).toEqual({
			kind: "focus-editor",
		});
	});
});

describe("moveTreeSelection", () => {
	it("clamps at both ends", () => {
		expect(moveTreeSelection(0, -1, 5)).toBe(0);
		expect(moveTreeSelection(4, 1, 5)).toBe(4);
		expect(moveTreeSelection(2, 1, 5)).toBe(3);
		expect(moveTreeSelection(0, 1, 0)).toBe(0);
	});
});
