/**
 * Pure decision core of the app-wide vim-style keyboard navigation: given a
 * key event's context, produce the action to perform. The React layer owns
 * the side effects (focus, layout, scrolling) and the leader timeout.
 *
 * Semantics mirrored exactly from the original App handler:
 * - A pending leader consumes the next key (cancelling the pending state is
 *   the caller's job); unbound keys produce `leader-cancel`, which must NOT
 *   preventDefault. Every other action claims the key.
 * - Inside Monaco the leader and Shift+H/L only fire from vim NORMAL mode.
 * - `noop` means the key is claimed (preventDefault) but nothing changes.
 */
export type FocusZone = "editor" | "tree" | "term";

export interface NavKeyContext {
	key: string;
	hasModifier: boolean;
	inMonaco: boolean;
	inTextInput: boolean;
	overlayOpen: boolean;
	leaderPending: boolean;
	leaderChar: string;
	/** True outside Monaco; inside, true only in vim NORMAL mode. */
	vimAllows: boolean;
	zone: FocusZone;
	termOpen: boolean;
	tabCount: number;
	treeSelected?: { kind: "folder" | "file"; collapsed?: boolean };
}

export type NavAction =
	| { kind: "leader-cancel" }
	| { kind: "leader-start" }
	| { kind: "focus-tree" }
	| { kind: "hide-tree" }
	| { kind: "focus-term" }
	| { kind: "hide-term" }
	| { kind: "focus-editor" }
	| { kind: "close-other-tabs" }
	| { kind: "cycle-tab"; direction: 1 | -1 }
	| { kind: "tree-move"; delta: 1 | -1 }
	| { kind: "tree-toggle-folder" }
	| { kind: "tree-open-file"; focusEditor: boolean }
	| { kind: "term-scroll"; amount: "step" | "half"; direction: 1 | -1 }
	| { kind: "term-bottom" }
	| { kind: "noop" };

export function resolveNavAction(context: NavKeyContext): NavAction | undefined {
	if (context.hasModifier || context.inTextInput || context.overlayOpen)
		return undefined;
	const { key, zone } = context;

	if (context.leaderPending) {
		const lower = key.toLowerCase();
		if (lower === "e")
			return zone === "tree" ? { kind: "hide-tree" } : { kind: "focus-tree" };
		if (lower === "t") {
			if (!context.termOpen) return { kind: "focus-term" };
			return zone === "term" ? { kind: "hide-term" } : { kind: "focus-term" };
		}
		if (lower === "h") {
			if (zone === "term") return { kind: "focus-editor" };
			if (zone === "editor") return { kind: "focus-tree" };
			return { kind: "noop" };
		}
		if (lower === "l") {
			if (zone === "tree") return { kind: "focus-editor" };
			if (zone === "editor") return { kind: "focus-term" };
			return { kind: "noop" };
		}
		if (lower === "o") return { kind: "close-other-tabs" };
		return { kind: "leader-cancel" };
	}

	if (key === context.leaderChar && context.vimAllows)
		return { kind: "leader-start" };

	if (
		(key === "H" || key === "L") &&
		context.vimAllows &&
		context.tabCount > 1
	)
		return { kind: "cycle-tab", direction: key === "L" ? 1 : -1 };

	if (zone === "editor" || context.inMonaco) return undefined;

	if (zone === "tree") {
		if (key === "j" || key === "ArrowDown") return { kind: "tree-move", delta: 1 };
		if (key === "k" || key === "ArrowUp") return { kind: "tree-move", delta: -1 };
		if (key === "Enter" || key === "l") {
			const row = context.treeSelected;
			if (!row) return { kind: "noop" };
			if (row.kind === "folder")
				return key === "l" && !row.collapsed
					? { kind: "noop" }
					: { kind: "tree-toggle-folder" };
			return { kind: "tree-open-file", focusEditor: key === "Enter" };
		}
		if (key === "h") {
			const row = context.treeSelected;
			return row?.kind === "folder" && !row.collapsed
				? { kind: "tree-toggle-folder" }
				: { kind: "noop" };
		}
		if (key === "Escape") return { kind: "focus-editor" };
		return undefined;
	}

	if (key === "j" || key === "ArrowDown")
		return { kind: "term-scroll", amount: "step", direction: 1 };
	if (key === "k" || key === "ArrowUp")
		return { kind: "term-scroll", amount: "step", direction: -1 };
	if (key === "d") return { kind: "term-scroll", amount: "half", direction: 1 };
	if (key === "u") return { kind: "term-scroll", amount: "half", direction: -1 };
	if (key === "G") return { kind: "term-bottom" };
	if (key === "Escape") return { kind: "focus-editor" };
	return undefined;
}

/** j/k selection movement, clamped to the visible tree rows. */
export function moveTreeSelection(
	selected: number,
	delta: 1 | -1,
	rowCount: number,
): number {
	return delta === 1
		? Math.min(selected + 1, Math.max(0, rowCount - 1))
		: Math.max(selected - 1, 0);
}
