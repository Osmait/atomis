import type * as MonacoApi from "monaco-editor";
import { VimMode } from "monaco-vim";

/**
 * App-level vim commands on top of monaco-vim: LSP/editor actions behind
 * their canonical vim keys (gd, gr, K, gcc, folds, visual =), plus ex
 * commands that talk to the workspace (:e, :bd, :only) and ZZ as :w (run).
 * monaco-vim's Vim registry is global, so this installs once; the app
 * refreshes the callback holder on every mount.
 */
export interface VimAppCommands {
	run: () => void;
	openOrCreateFile: (name: string | undefined) => void;
	closeActiveTab: () => void;
	closeOtherTabs: () => void;
}

interface VimAdapter {
	editor?: MonacoApi.editor.IStandaloneCodeEditor;
}

interface VimApi {
	defineAction: (
		name: string,
		fn: (cm: VimAdapter) => void,
	) => void;
	mapCommand: (
		keys: string,
		type: "action",
		name: string,
		args: Record<string, never>,
		extra: { context?: "normal" | "visual" },
	) => void;
	defineEx: (
		name: string,
		prefix: string,
		fn: (cm: VimAdapter, params: { args?: string[] }) => void,
	) => void;
	exitVisualMode: (cm: VimAdapter) => void;
}

const commands: VimAppCommands = {
	run: () => undefined,
	openOrCreateFile: () => undefined,
	closeActiveTab: () => undefined,
	closeOtherTabs: () => undefined,
};

export function updateVimAppCommands(next: VimAppCommands): void {
	Object.assign(commands, next);
}

let installed = false;

export function installVimExtensions(): void {
	if (installed) return;
	installed = true;
	const vim = (VimMode as object as { Vim: VimApi }).Vim;

	const editorAction =
		(id: string) =>
		(cm: VimAdapter): void => {
			cm.editor?.trigger("vim", id, null);
		};
	const normal = (keys: string, name: string, actionId: string): void => {
		vim.defineAction(name, editorAction(actionId));
		vim.mapCommand(keys, "action", name, {}, { context: "normal" });
	};

	normal("gd", "atomisGoToDefinition", "editor.action.revealDefinition");
	normal("gr", "atomisGoToReferences", "editor.action.goToReferences");
	vim.defineAction("atomisHover", (cm) => {
		const editor = cm.editor;
		setTimeout(() => editor?.trigger("vim", "editor.action.showHover", null), 80);
	});
	vim.mapCommand("K", "action", "atomisHover", {}, { context: "normal" });
	normal("gcc", "atomisToggleComment", "editor.action.commentLine");
	normal("za", "atomisFoldToggle", "editor.toggleFold");
	normal("zc", "atomisFold", "editor.fold");
	normal("zo", "atomisUnfold", "editor.unfold");
	normal("zR", "atomisUnfoldAll", "editor.unfoldAll");
	normal("zM", "atomisFoldAll", "editor.foldAll");

	vim.defineAction("atomisCommentSelection", (cm) => {
		cm.editor?.trigger("vim", "editor.action.commentLine", null);
		vim.exitVisualMode(cm);
	});
	vim.mapCommand("gc", "action", "atomisCommentSelection", {}, {
		context: "visual",
	});
	vim.defineAction("atomisFormatSelection", (cm) => {
		cm.editor?.trigger("vim", "editor.action.formatSelection", null);
		vim.exitVisualMode(cm);
	});
	vim.mapCommand("=", "action", "atomisFormatSelection", {}, {
		context: "visual",
	});

	vim.defineAction("atomisWriteRun", () => commands.run());
	vim.mapCommand("ZZ", "action", "atomisWriteRun", {}, { context: "normal" });

	vim.defineEx("edit", "e", (_cm, params) =>
		commands.openOrCreateFile(params.args?.[0]),
	);
	vim.defineEx("bdelete", "bd", () => commands.closeActiveTab());
	vim.defineEx("only", "on", () => commands.closeOtherTabs());
}
