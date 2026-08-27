import { useEffect } from "react";
import { VALUE_FMTS } from "../lowlevel.js";

interface GlobalShortcutOptions {
	paletteOpenRef: React.RefObject<boolean>;
	closePalette: () => void;
	run: () => void;
	toggleZen: () => void;
	toggleTree: () => void;
	toggleTerm: () => void;
	openPalette: () => void;
	formatDocument: () => void;
	toggleDrawer: () => void;
	toggleSettings: () => void;
	setValueFmtIndex: (index: number) => void;
}

/**
 * The Ctrl/Cmd chords: ⌘↵ run, ⌘. zen, ⌘B tree, ⌘J terminal, ⌘K palette,
 * ⌘S format, ⌘T tests drawer, ⌘, settings, ⌘1–5 inline-value format —
 * plus Escape closing the palette.
 */
export function useGlobalShortcuts(options: GlobalShortcutOptions): void {
	const {
		paletteOpenRef,
		closePalette,
		run,
		toggleZen,
		toggleTree,
		toggleTerm,
		openPalette,
		formatDocument,
		toggleDrawer,
		toggleSettings,
		setValueFmtIndex,
	} = options;
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && paletteOpenRef.current) {
				closePalette();
				return;
			}
			const mod = event.metaKey || event.ctrlKey;
			if (!mod) return;
			const key = event.key.toLowerCase();
			const claim = (): void => {
				event.preventDefault();
				event.stopPropagation();
			};
			if (event.key === "Enter") {
				claim();
				run();
			} else if (event.key === ".") {
				claim();
				toggleZen();
			} else if (key === "b") {
				claim();
				toggleTree();
			} else if (key === "j") {
				claim();
				toggleTerm();
			} else if (key === "k") {
				claim();
				openPalette();
			} else if (key === "s") {
				claim();
				formatDocument();
			} else if (key === "t") {
				claim();
				toggleDrawer();
			} else if (event.key === ",") {
				claim();
				toggleSettings();
			} else if ("12345".includes(event.key)) {
				claim();
				if (VALUE_FMTS[Number(event.key) - 1])
					setValueFmtIndex(Number(event.key) - 1);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [
		closePalette,
		formatDocument,
		openPalette,
		paletteOpenRef,
		run,
		setValueFmtIndex,
		toggleDrawer,
		toggleSettings,
		toggleTerm,
		toggleTree,
		toggleZen,
	]);
}
