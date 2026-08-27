import { useEffect, useRef } from "react";
import type * as MonacoApi from "monaco-editor";
import { quickScopeTargets } from "../state/quickScope.js";

interface QuickScopeOptions {
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	cursor: { line: number; column: number };
	vimEnabled: boolean;
	vimModeLabel: string;
	activePath: string;
}

/**
 * Quick-scope highlighting for f/F/t/T: while vim sits in NORMAL mode,
 * the reachable character of every word on the cursor's line is underlined
 * (bright when one f lands there, dimmer when it needs f;), so the motion's
 * targets are visible before the key is pressed.
 */
export function useQuickScope(options: QuickScopeOptions): void {
	const { editorRef, cursor, vimEnabled, vimModeLabel, activePath } = options;
	const decorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;
		decorationsRef.current ??= editor.createDecorationsCollection();
		const decorations = decorationsRef.current;
		const model = editor.getModel();
		if (
			!model ||
			!vimEnabled ||
			vimModeLabel !== "NORMAL" ||
			cursor.line > model.getLineCount()
		) {
			decorations.set([]);
			return;
		}
		const targets = quickScopeTargets(
			model.getLineContent(cursor.line),
			cursor.column,
		);
		const decorate = (
			columns: number[],
			className: string,
		): MonacoApi.editor.IModelDeltaDecoration[] =>
			columns.map((column) => ({
				range: {
					startLineNumber: cursor.line,
					startColumn: column,
					endLineNumber: cursor.line,
					endColumn: column + 1,
				} as MonacoApi.Range,
				options: { inlineClassName: className },
			}));
		decorations.set([
			...decorate(targets.primary, "qs-primary"),
			...decorate(targets.secondary, "qs-secondary"),
		]);
	}, [activePath, cursor, editorRef, vimEnabled, vimModeLabel]);
}
