import type * as MonacoApi from "monaco-editor";
import { VimMode } from "monaco-vim";
import {
	changePairEdits,
	deletePairEdits,
	findEnclosingPair,
	surroundPairFor,
	wrapEdits,
	type Position,
	type SurroundEdit,
} from "../../shared/lib/surround.js";

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
	openDialog?: (
		template: Node,
		callback: ((value: string) => void) | undefined,
		options: {
			bottom?: boolean;
			onKeyDown?: (
				event: KeyboardEvent,
				value: string,
				close: () => void,
			) => boolean;
		},
	) => void;
}

interface VimApi {
	defineAction: (
		name: string,
		fn: (
			cm: VimAdapter,
			args?: { selectedCharacter?: string },
		) => void,
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

function applyEdits(
	editor: MonacoApi.editor.IStandaloneCodeEditor,
	edits: SurroundEdit[],
): void {
	if (!edits.length) return;
	editor.pushUndoStop();
	editor.executeEdits(
		"vim-surround",
		edits.map((edit) => ({
			range: {
				startLineNumber: edit.startLine,
				startColumn: edit.startColumn,
				endLineNumber: edit.endLine,
				endColumn: edit.endColumn,
			},
			text: edit.text,
			forceMoveMarkers: true,
		})),
	);
	editor.pushUndoStop();
}

function cursorOf(
	editor: MonacoApi.editor.IStandaloneCodeEditor,
): Position | undefined {
	const position = editor.getPosition();
	return position
		? { line: position.lineNumber, column: position.column }
		: undefined;
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
	normal("gr", "atomisGoToReferences", "editor.action.referenceSearch.trigger");
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

	// ── vim-surround under the gs namespace: after an operator key (y/d/c)
	// vim commits the built-in full match instantly, so ys/ds/cs sequences
	// can never reach a custom mapping — gs is a free, non-operator prefix.
	// gsw = surround word · gss = line · gsd = delete pair · gsc = change
	// pair · visual gs = wrap selection ──
	vim.defineAction("atomisSurroundWord", (cm, args) => {
		const editor = cm.editor;
		const pair = surroundPairFor(args?.selectedCharacter ?? "");
		const position = editor?.getPosition();
		const model = editor?.getModel();
		if (!editor || !pair || !position || !model) return;
		const word = model.getWordAtPosition(position);
		if (!word) return;
		applyEdits(editor, [
			...wrapEdits(
				{ line: position.lineNumber, column: word.startColumn },
				{ line: position.lineNumber, column: word.endColumn },
				pair,
			),
		]);
	});
	vim.mapCommand("gsw<character>", "action", "atomisSurroundWord", {}, {
		context: "normal",
	});

	vim.defineAction("atomisSurroundLine", (cm, args) => {
		const editor = cm.editor;
		const pair = surroundPairFor(args?.selectedCharacter ?? "");
		const position = editor?.getPosition();
		const model = editor?.getModel();
		if (!editor || !pair || !position || !model) return;
		const text = model.getLineContent(position.lineNumber);
		const first = text.length - text.trimStart().length + 1;
		applyEdits(editor, [
			...wrapEdits(
				{ line: position.lineNumber, column: first },
				{ line: position.lineNumber, column: text.length + 1 },
				pair,
			),
		]);
	});
	vim.mapCommand("gss<character>", "action", "atomisSurroundLine", {}, {
		context: "normal",
	});

	vim.defineAction("atomisSurroundVisual", (cm, args) => {
		const editor = cm.editor;
		const pair = surroundPairFor(args?.selectedCharacter ?? "");
		const selection = editor?.getSelection();
		if (!editor || !pair || !selection) return;
		applyEdits(editor, [
			...wrapEdits(
				{
					line: selection.startLineNumber,
					column: selection.startColumn,
				},
				{ line: selection.endLineNumber, column: selection.endColumn },
				pair,
			),
		]);
		vim.exitVisualMode(cm);
	});
	vim.mapCommand("gs<character>", "action", "atomisSurroundVisual", {}, {
		context: "visual",
	});

	vim.defineAction("atomisDeleteSurround", (cm, args) => {
		const editor = cm.editor;
		const model = editor?.getModel();
		const cursor = editor ? cursorOf(editor) : undefined;
		if (!editor || !model || !cursor) return;
		const found = findEnclosingPair(
			model.getLinesContent(),
			cursor,
			args?.selectedCharacter ?? "",
		);
		if (found) applyEdits(editor, deletePairEdits(found));
	});
	vim.mapCommand("gsd<character>", "action", "atomisDeleteSurround", {}, {
		context: "normal",
	});

	vim.defineAction("atomisChangeSurround", (cm, args) => {
		const editor = cm.editor;
		const model = editor?.getModel();
		const cursor = editor ? cursorOf(editor) : undefined;
		if (!editor || !model || !cursor) return;
		const found = findEnclosingPair(
			model.getLinesContent(),
			cursor,
			args?.selectedCharacter ?? "",
		);
		if (!found) return;
		const change = (char: string): void => {
			const next = surroundPairFor(char);
			if (next) applyEdits(editor, changePairEdits(found, next));
		};
		if (!cm.openDialog) return;
		// The status bar escapes string templates, so the input must be a
		// real DOM node; onKeyDown grabs the very first keypress so no
		// Enter is needed.
		const template = document.createElement("span");
		template.append("surround with: ");
		const field = document.createElement("input");
		field.type = "text";
		field.style.width = "4ch";
		field.spellcheck = false;
		template.append(field);
		cm.openDialog(
			template,
			(value) => change(value[0] ?? ""),
			{
			bottom: true,
			onKeyDown: (event, _value, close) => {
				event.preventDefault();
				event.stopPropagation();
				close();
				if (event.key.length === 1) change(event.key);
				return true;
			},
			},
		);
	});
	vim.mapCommand("gsc<character>", "action", "atomisChangeSurround", {}, {
		context: "normal",
	});

	vim.defineEx("edit", "e", (_cm, params) =>
		commands.openOrCreateFile(params.args?.[0]),
	);
	vim.defineEx("bdelete", "bd", () => commands.closeActiveTab());
	vim.defineEx("only", "on", () => commands.closeOtherTabs());
}
