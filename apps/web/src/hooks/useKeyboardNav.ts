import { useCallback, useEffect, useRef, useState } from "react";
import type * as MonacoApi from "monaco-editor";
import { LEADER_KEYS, type Appearance } from "../state/appearance.js";
import {
	moveTreeSelection,
	resolveNavAction,
	type FocusZone,
} from "../state/keyboardNav.js";
import type { LayoutState } from "../state/settings.js";
import { cycleTab } from "../state/tabs.js";

export interface TreeNavRow {
	kind: "folder" | "file";
	path: string;
	collapsed?: boolean;
}

interface KeyboardNavOptions {
	appearanceRef: React.RefObject<Appearance>;
	vimEnabledRef: React.RefObject<boolean>;
	vimModeRef: React.RefObject<string>;
	paletteOpenRef: React.RefObject<boolean>;
	layoutRef: React.RefObject<LayoutState>;
	updateLayout: (patch: Partial<LayoutState>) => void;
	openTabsRef: React.RefObject<string[]>;
	activePathRef: React.RefObject<string>;
	treeNavRef: React.RefObject<TreeNavRow[]>;
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	selectFile: (path: string) => void;
	toggleFolder: (path: string) => void;
	closeOtherTabs: () => void;
	expandTreeRoot: () => void;
}

export interface KeyboardNav {
	focusZone: FocusZone;
	focusZoneRef: React.RefObject<FocusZone>;
	setFocusZone: (zone: FocusZone) => void;
	leaderPending: boolean;
	treeSel: number;
	setTreeSel: React.Dispatch<React.SetStateAction<number>>;
	focusEditorZone: () => void;
	focusTreeZone: () => void;
	focusTermZone: () => void;
}

/**
 * App-wide vim-style navigation: the leader key (with its 1.5 s window),
 * Shift+H/L tab cycling, and j/k movement inside the tree and terminal
 * zones. Key decisions come from the pure `resolveNavAction`; this hook owns
 * the zone/leader state and the side effects.
 */
export function useKeyboardNav(options: KeyboardNavOptions): KeyboardNav {
	const {
		appearanceRef,
		vimEnabledRef,
		vimModeRef,
		paletteOpenRef,
		layoutRef,
		updateLayout,
		openTabsRef,
		activePathRef,
		treeNavRef,
		editorRef,
		selectFile,
		toggleFolder,
		closeOtherTabs,
		expandTreeRoot,
	} = options;
	const [focusZone, setFocusZone] = useState<FocusZone>("editor");
	const focusZoneRef = useRef<FocusZone>("editor");
	focusZoneRef.current = focusZone;
	const [leaderPending, setLeaderPending] = useState(false);
	const leaderPendingRef = useRef(false);
	const leaderTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const [treeSel, setTreeSel] = useState(0);
	const treeSelRef = useRef(0);
	treeSelRef.current = treeSel;

	const focusEditorZone = useCallback((): void => {
		setFocusZone("editor");
		editorRef.current?.focus();
	}, [editorRef]);

	const focusTreeZone = useCallback((): void => {
		updateLayout({ treeOpen: true, zen: false });
		expandTreeRoot();
		const rows = treeNavRef.current;
		const activeIndex = rows.findIndex(
			(row) => row.kind === "file" && row.path === activePathRef.current,
		);
		setTreeSel(Math.max(activeIndex, 0));
		setFocusZone("tree");
		(document.activeElement as HTMLElement | null)?.blur?.();
	}, [activePathRef, expandTreeRoot, treeNavRef, updateLayout]);

	const focusTermZone = useCallback((): void => {
		updateLayout({ termOpen: true, zen: false });
		setFocusZone("term");
		(document.activeElement as HTMLElement | null)?.blur?.();
	}, [updateLayout]);

	// Keep the keyboard selection visible while navigating the tree.
	useEffect(() => {
		if (focusZone !== "tree") return;
		document
			.querySelector(".file-tree .kb-sel")
			?.scrollIntoView({ block: "nearest" });
	}, [focusZone, treeSel]);

	useEffect(() => {
		const cancelLeader = (): void => {
			leaderPendingRef.current = false;
			setLeaderPending(false);
			if (leaderTimerRef.current) clearTimeout(leaderTimerRef.current);
		};
		const scrollTermPanel = (
			apply: (panel: HTMLElement) => void,
		): void => {
			const panel = document.querySelector<HTMLElement>(
				".side-panel .panel-content",
			);
			if (panel) apply(panel);
		};
		const onKey = (event: KeyboardEvent): void => {
			const target = event.target as HTMLElement | null;
			const inMonaco = Boolean(target?.closest?.(".monaco-editor"));
			const inTextInput =
				!inMonaco &&
				Boolean(
					target?.closest?.("input, textarea, select, [contenteditable]"),
				);
			const rows = treeNavRef.current;
			const selectedRow = rows[treeSelRef.current];
			const action = resolveNavAction({
				key: event.key,
				hasModifier: event.metaKey || event.ctrlKey || event.altKey,
				inMonaco,
				inTextInput,
				overlayOpen:
					paletteOpenRef.current ||
					Boolean(document.querySelector(".settings-modal")),
				leaderPending: leaderPendingRef.current,
				leaderChar: LEADER_KEYS[appearanceRef.current.leader],
				vimAllows: inMonaco
					? vimEnabledRef.current && vimModeRef.current === "NORMAL"
					: true,
				zone: focusZoneRef.current,
				termOpen: layoutRef.current.termOpen,
				tabCount: openTabsRef.current.length,
				...(selectedRow
					? {
							treeSelected: {
								kind: selectedRow.kind,
								...(selectedRow.collapsed !== undefined
									? { collapsed: selectedRow.collapsed }
									: {}),
							},
						}
					: {}),
			});
			if (leaderPendingRef.current) cancelLeader();
			if (!action || action.kind === "leader-cancel") return;
			event.preventDefault();
			event.stopPropagation();
			switch (action.kind) {
				case "leader-start":
					leaderPendingRef.current = true;
					setLeaderPending(true);
					leaderTimerRef.current = setTimeout(cancelLeader, 1500);
					break;
				case "focus-tree":
					focusTreeZone();
					break;
				case "hide-tree":
					updateLayout({ treeOpen: false });
					focusEditorZone();
					break;
				case "focus-term":
					focusTermZone();
					break;
				case "hide-term":
					updateLayout({ termOpen: false });
					focusEditorZone();
					break;
				case "focus-editor":
					focusEditorZone();
					break;
				case "close-other-tabs":
					closeOtherTabs();
					break;
				case "cycle-tab": {
					const next = cycleTab(
						openTabsRef.current,
						activePathRef.current,
						action.direction,
					);
					if (next) selectFile(next);
					break;
				}
				case "tree-move":
					setTreeSel((previous) =>
						moveTreeSelection(previous, action.delta, rows.length),
					);
					break;
				case "tree-toggle-folder":
					if (selectedRow) toggleFolder(selectedRow.path);
					break;
				case "tree-open-file":
					if (selectedRow) {
						selectFile(selectedRow.path);
						if (action.focusEditor) focusEditorZone();
					}
					break;
				case "term-scroll":
					scrollTermPanel((panel) => {
						const amount =
							action.amount === "step" ? 48 : panel.clientHeight / 2;
						panel.scrollTop += amount * action.direction;
					});
					break;
				case "term-bottom":
					scrollTermPanel((panel) => {
						panel.scrollTop = panel.scrollHeight;
					});
					break;
				case "noop":
					break;
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [
		appearanceRef,
		activePathRef,
		closeOtherTabs,
		focusEditorZone,
		focusTreeZone,
		focusTermZone,
		layoutRef,
		openTabsRef,
		paletteOpenRef,
		selectFile,
		toggleFolder,
		treeNavRef,
		updateLayout,
		vimEnabledRef,
		vimModeRef,
	]);

	return {
		focusZone,
		focusZoneRef,
		setFocusZone,
		leaderPending,
		treeSel,
		setTreeSel,
		focusEditorZone,
		focusTreeZone,
		focusTermZone,
	};
}
