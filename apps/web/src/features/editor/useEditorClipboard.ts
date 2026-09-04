import { useCallback } from "react";
import type * as MonacoApi from "monaco-editor";
import type { EditorContextMenuState } from "./editorContextMenu.js";

/** What copy and paste touch besides the editor itself. */
export interface EditorClipboardDeps {
	editorRef: React.RefObject<MonacoApi.editor.IStandaloneCodeEditor | undefined>;
	setEditorContextMenu: (menu: EditorContextMenuState | undefined) => void;
	setStatus: (status: string) => void;
}

/**
 * Copy and paste that go through the system clipboard rather than Monaco's
 * own, because the app's context menu offers them and a browser only grants
 * clipboard access to a real gesture. With no selection, copy takes the
 * whole line — the editor convention people expect.
 */
export function useEditorClipboard({
	editorRef,
	setEditorContextMenu,
	setStatus,
}: EditorClipboardDeps): {
	copyFromEditor: (
		textOverride?: string,
		sourceEditor?: MonacoApi.editor.ICodeEditor,
	) => Promise<void>;
	pasteIntoEditor: () => Promise<void>;
} {
	const copyFromEditor = useCallback(async (
		textOverride?: string,
		sourceEditor?: MonacoApi.editor.ICodeEditor,
	): Promise<void> => {
		setEditorContextMenu(undefined);
		const editor = sourceEditor ?? editorRef.current;
		let text = textOverride;
		if (text === undefined) {
			const model = editor?.getModel();
			const selection = editor?.getSelection();
			if (!editor || !model || !selection) return;
			text = selection.isEmpty()
				? model.getLineContent(selection.startLineNumber)
				: model.getValueInRange(selection);
		}
		try {
			await navigator.clipboard.writeText(text);
		} catch (error) {
			setStatus(
				`Copy failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (editor?.getDomNode()?.isConnected) editor.focus();
	}, [editorRef, setEditorContextMenu, setStatus]);

	const pasteIntoEditor = useCallback(async (): Promise<void> => {
		setEditorContextMenu(undefined);
		const editor = editorRef.current;
		if (!editor) return;
		editor.focus();
		const selection = editor.getSelection();
		if (!selection) return;
		try {
			const text = await navigator.clipboard.readText();
			editor.executeEdits("atomis.clipboard", [
				{ range: selection, text, forceMoveMarkers: true },
			]);
		} catch (error) {
			setStatus(
				`Paste failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		editor.focus();
	}, [editorRef, setEditorContextMenu, setStatus]);

	return { copyFromEditor, pasteIntoEditor };
}
