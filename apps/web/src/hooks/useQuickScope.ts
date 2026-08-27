import { useEffect, useRef, useState } from "react";
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
 * Quick-scope highlighting for f/F/t/T, in its highlight-on-keys flavour:
 * the targets light up only while the motion awaits its character (f/t for
 * the right side, F/T for the left), and any other key clears them — so
 * the editor stays clean until the hint is actually useful.
 */
export function useQuickScope(options: QuickScopeOptions): void {
	const { editorRef, cursor, vimEnabled, vimModeLabel, activePath } = options;
	const [pending, setPending] = useState<"right" | "left" | null>(null);
	const decorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;
		const armed = vimEnabled && vimModeLabel === "NORMAL";
		const listener = editor.onKeyDown((event) => {
			const key = event.browserEvent.key;
			const plain =
				!event.browserEvent.ctrlKey &&
				!event.browserEvent.metaKey &&
				!event.browserEvent.altKey;
			if (armed && plain && (key === "f" || key === "t"))
				setPending("right");
			else if (armed && plain && (key === "F" || key === "T"))
				setPending("left");
			else setPending(null);
		});
		return () => listener.dispose();
	}, [cursor, editorRef, vimEnabled, vimModeLabel]);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;
		decorationsRef.current ??= editor.createDecorationsCollection();
		const decorations = decorationsRef.current;
		const model = editor.getModel();
		if (
			!model ||
			!pending ||
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
		const wanted = (column: number): boolean =>
			pending === "right" ? column > cursor.column : column < cursor.column;
		const decorate = (
			columns: number[],
			className: string,
		): MonacoApi.editor.IModelDeltaDecoration[] =>
			columns.filter((column) => wanted(column)).map((column) => ({
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
	}, [activePath, cursor, editorRef, pending, vimEnabled, vimModeLabel]);
}
