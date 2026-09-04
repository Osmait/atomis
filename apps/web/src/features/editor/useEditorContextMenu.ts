import { useEffect } from "react";
import type * as MonacoApi from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import type { EditorContextMenuState } from "./editorContextMenu.js";
import {
	getContextualEditorCopy,
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
						candidate.getContainerDomNode() === clickedEditorNode,
				);
			if (clickedEditor) {
				editorRef.current =
					clickedEditor as MonacoApi.editor.IStandaloneCodeEditor;
			}
			const contextualCopy = getContextualEditorCopy(event.target);
			const copyLabel = nestedEditor
				? "Copy reference"
				: contextualCopy?.label;
			event.preventDefault();
			event.stopPropagation();
			setEditorContextMenu({
				x: Math.min(event.clientX, window.innerWidth - 170),
				y: Math.min(event.clientY, window.innerHeight - 90),
				allowPaste: !nestedEditor && !contextualCopy,
				...(copyLabel ? { copyLabel } : {}),
				...(!nestedEditor && contextualCopy
					? {
							copyText: contextualCopy.text,
						}
					: {}),
			});
		};
		window.addEventListener("contextmenu", showContextMenu, true);
		return () =>
			window.removeEventListener("contextmenu", showContextMenu, true);
	}, [editorRef, monacoRef, setEditorContextMenu]);
}
