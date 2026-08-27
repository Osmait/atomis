import { useEffect, useRef, useState } from "react";
import type * as MonacoApi from "monaco-editor";
import {
	charMatchColumns,
	quickScopeTargets,
} from "../state/quickScope.js";

interface QuickScopeOptions {
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	cursor: { line: number; column: number };
	vimEnabled: boolean;
	vimModeLabel: string;
	activePath: string;
}

type Phase =
	| { kind: "idle" }
	| { kind: "awaiting"; direction: "right" | "left" }
	| { kind: "active"; char: string };

/**
 * Two-phase f/F/t/T assistance:
 * - while the motion awaits its character, each word on the jump's side
 *   shows the char a single press lands on (quick-scope);
 * - once the character is typed, every occurrence of THAT character on the
 *   line stays highlighted (clever-f), so `;`/`,` repeats are visible.
 * Any other key clears the overlay; insert mode never arms it.
 */
export function useQuickScope(options: QuickScopeOptions): void {
	const { editorRef, cursor, vimEnabled, vimModeLabel, activePath } = options;
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const phaseRef = useRef<Phase>(phase);
	phaseRef.current = phase;
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
			const current = phaseRef.current;
			if (!armed || !plain) {
				if (current.kind !== "idle") setPhase({ kind: "idle" });
				return;
			}
			if (current.kind === "awaiting") {
				setPhase(
					key.length === 1
						? { kind: "active", char: key }
						: { kind: "idle" },
				);
				return;
			}
			if (key === "f" || key === "t") {
				setPhase({ kind: "awaiting", direction: "right" });
				return;
			}
			if (key === "F" || key === "T") {
				setPhase({ kind: "awaiting", direction: "left" });
				return;
			}
			if (current.kind === "active" && (key === ";" || key === ","))
				return;
			if (current.kind !== "idle") setPhase({ kind: "idle" });
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
			phase.kind === "idle" ||
			!vimEnabled ||
			vimModeLabel !== "NORMAL" ||
			cursor.line > model.getLineCount()
		) {
			decorations.set([]);
			return;
		}
		const lineText = model.getLineContent(cursor.line);
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
		if (phase.kind === "active") {
			decorations.set(
				decorate(
					charMatchColumns(lineText, phase.char).filter(
						(column) => column !== cursor.column,
					),
					"qs-match",
				),
			);
			return;
		}
		const targets = quickScopeTargets(lineText, cursor.column);
		const wanted = (column: number): boolean =>
			phase.direction === "right"
				? column > cursor.column
				: column < cursor.column;
		decorations.set([
			...decorate(
				targets.primary.filter((column) => wanted(column)),
				"qs-primary",
			),
			...decorate(
				targets.secondary.filter((column) => wanted(column)),
				"qs-secondary",
			),
		]);
	}, [activePath, cursor, editorRef, phase, vimEnabled, vimModeLabel]);
}
