import type * as MonacoApi from "monaco-editor";
import {
	initVimMode,
	StatusBar as VimStatusBar,
	VimMode,
	type VimAdapterInstance,
} from "monaco-vim";
import { useCallback, useEffect, useRef, useState } from "react";

import { loadVimMode, saveVimMode } from "../../shared/stores/settings.js";

interface VimModeWithCommands {
	Vim: {
		defineEx: (name: string, prefix: string, callback: () => void) => void;
		unmap: (keys: string, context?: "normal" | "insert" | "visual") => boolean;
		exitInsertMode: (adapter: object) => void;
		exitVisualMode: (adapter: object) => void;
	};
}

interface VimAdapterState {
	state?: { vim?: { insertMode?: boolean; visualMode?: boolean } };
}

/**
 * monaco-vim reports the mode by calling into the status bar it was given,
 * and it constructs that itself — so the only way to hear about a mode
 * change is a module-level listener the class writes through.
 */
let vimModeListener: ((mode: string) => void) | undefined;

class NvimStatusBar extends VimStatusBar {
	override setMode(event: { mode: string; subMode?: string }): void {
		const suffix =
			event.mode === "visual" && event.subMode
				? ` ${event.subMode.replace("wise", "").toUpperCase()}`
				: "";
		vimModeListener?.(`${event.mode.toUpperCase()}${suffix}`);
	}
}

interface VimOptions {
	editorRef: React.RefObject<MonacoApi.editor.IStandaloneCodeEditor | undefined>;
}

/**
 * Vim mode: whether it is on, what mode it reports, and the adapter bound to
 * the editor. Turning it off disposes the adapter rather than leaving it
 * attached and ignored, so the editor's own key handling comes back.
 */
export function useVim(options: VimOptions) {
	const { editorRef } = options;
	const [enabled, setEnabled] = useState(loadVimMode);
	const [modeLabel, setModeLabel] = useState("NORMAL");
	const enabledRef = useRef(enabled);
	const modeRef = useRef("NORMAL");
	const adapterRef = useRef<VimAdapterInstance | null>(null);
	const statusRef = useRef<HTMLDivElement | null>(null);
	modeRef.current = modeLabel;

	useEffect(() => {
		vimModeListener = setModeLabel;
		return () => {
			vimModeListener = undefined;
		};
	}, []);

	useEffect(() => {
		setModeLabel(enabled ? "NORMAL" : "EDIT");
	}, [enabled]);

	/** Binds the adapter to the editor, or takes it away. */
	const attach = useCallback((): void => {
		adapterRef.current?.dispose();
		adapterRef.current = null;
		if (enabledRef.current && editorRef.current && statusRef.current)
			adapterRef.current = initVimMode(
				editorRef.current,
				statusRef.current,
				NvimStatusBar,
			);
	}, [editorRef]);

	const setVimEnabled = useCallback(
		(next: boolean): void => {
			enabledRef.current = next;
			setEnabled(next);
			saveVimMode(next);
			attach();
			editorRef.current?.focus();
		},
		[attach, editorRef],
	);

	/**
	 * Formatting from insert or visual mode leaves the caret somewhere the
	 * user did not put it, so step back to normal first. The adapter may not
	 * have state yet on the very first keystroke; formatting still applies.
	 */
	const formatAndNormal = useCallback((): void => {
		const editor = editorRef.current;
		if (!editor) return;
		const vimCommands = VimMode as object as VimModeWithCommands;
		const adapter = adapterRef.current as VimAdapterState | null;
		try {
			if (adapter?.state?.vim?.insertMode)
				vimCommands.Vim.exitInsertMode(adapter);
			else if (adapter?.state?.vim?.visualMode)
				vimCommands.Vim.exitVisualMode(adapter);
		} catch {
			// vim state not ready yet; formatting still applies
		}
		void editor.getAction("editor.action.formatDocument")?.run();
	}, [editorRef]);

	/**
	 * Applies a change that came from another device: no save, because the
	 * value arrived from the store that would be saved to.
	 */
	const syncVimEnabled = useCallback(
		(next: boolean): void => {
			enabledRef.current = next;
			setEnabled(next);
			attach();
		},
		[attach],
	);

	/**
	 * Frees the chords the editor wants for itself, and teaches vim `:w`.
	 * Called once the editor exists, since monaco-vim keeps these globally —
	 * which is exactly why `:w` takes a REF to the runner: defineEx keeps
	 * this closure for the page's whole life, while the runner is rebuilt
	 * per session (it embeds the sessionId). A direct function here kept the
	 * first session's runner, and `:w` after a workspace switch sent the old
	 * sessionId — which the server answers by closing the socket.
	 */
	const setupVimKeys = useCallback(
		(writeRef: React.RefObject<() => void>): void => {
			const vimCommands = VimMode as object as VimModeWithCommands;
			for (const shortcut of ["<C-a>", "<C-c>", "<C-v>", "<C-x>"])
				vimCommands.Vim.unmap(shortcut);
			vimCommands.Vim.unmap("<C-c>", "insert");
			vimCommands.Vim.defineEx("write", "w", () => writeRef.current());
		},
		[],
	);

	const dispose = useCallback((): void => {
		adapterRef.current?.dispose();
		adapterRef.current = null;
	}, []);

	return {
		vimEnabled: enabled,
		vimEnabledRef: enabledRef,
		vimModeLabel: modeLabel,
		vimModeRef: modeRef,
		vimRef: adapterRef,
		vimStatusRef: statusRef,
		changeVimMode: setVimEnabled,
		syncVimEnabled,
		setupVimKeys,
		attachVim: attach,
		formatAndNormal,
		disposeVim: dispose,
	};
}
