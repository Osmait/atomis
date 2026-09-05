import { useEffect } from "react";
import type * as MonacoApi from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import type { EditorContextMenuState } from "./editorContextMenu.js";
import {
	getContextualEditorCopy,
	getEditorCopyText,
	getMonacoEditorTarget,
	isNestedMonacoEditor,
} from "./editorContextMenu.js";

interface EditorContextMenuDeps {
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	monacoRef: React.RefObject<Monaco | undefined>;
	setEditorContextMenu: (menu: EditorContextMenuState | undefined) => void;
}

/**
 * Keep the editor menu attached to the app rather than a Monaco model.
 * Monaco can dispose and replace its first model during session startup
 * without mounting the React component again.
 */
export function useEditorContextMenu({
	editorRef,
	monacoRef,
	setEditorContextMenu,
}: EditorContextMenuDeps): void {
	useEffect(() => {
		const showContextMenu = (event: MouseEvent): void => {
			const clickedEditorNode = getMonacoEditorTarget(event.target);
			if (!clickedEditorNode?.closest(".editor-wrap")) return;
			const nestedEditor = isNestedMonacoEditor(event.target);
			const clickedEditor = monacoRef.current?.editor
				.getEditors()
				.find(
					(candidate: MonacoApi.editor.ICodeEditor) =>
						candidate.getDomNode() === clickedEditorNode,
				);
			const contextualCopy = getContextualEditorCopy(event.target);
			// Never redirect the app's main editor ref to a disposable peek editor.
			// A missing preview must not silently copy from the main model either.
			const copyEditor = clickedEditor ??
				(editorRef.current?.getDomNode() === clickedEditorNode
					? editorRef.current
					: undefined);
			const copyText = contextualCopy?.text ?? (copyEditor
				? getEditorCopyText(
					copyEditor,
					copyEditor.getTargetAtClientPoint(event.clientX, event.clientY)?.position,
				)
				: undefined);
			if (copyText === undefined) return;
			const copyLabel = contextualCopy?.label ??
				(nestedEditor ? "Copy reference" : undefined);
			event.preventDefault();
			event.stopPropagation();
			setEditorContextMenu({
				x: Math.min(event.clientX, window.innerWidth - 170),
				y: Math.min(event.clientY, window.innerHeight - 90),
				allowPaste: !nestedEditor && !contextualCopy,
				copyText,
				...(copyEditor ? { copyEditor } : {}),
				...(copyLabel ? { copyLabel } : {}),
			});
		};
		window.addEventListener("contextmenu", showContextMenu, true);
		return () =>
			window.removeEventListener("contextmenu", showContextMenu, true);
	}, [editorRef, monacoRef, setEditorContextMenu]);
}
