import { useEffect, useRef, useState } from "react";
import type * as MonacoApi from "monaco-editor";
import { charMatchPositions } from "../shared/lib/quickScope.js";

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
	| { kind: "awaiting" }
	| { kind: "active"; char: string };

/**
 * clever-f for f/F/t/T: nothing shows while the motion awaits its
 * character; once it is typed, every occurrence of THAT character on the
 * line stays highlighted so `;`/`,` repeats are visible. Any other key
 * clears the overlay; insert mode never arms it.
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
			if (key === "f" || key === "t" || key === "F" || key === "T") {
				setPhase({ kind: "awaiting" });
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
			phase.kind !== "active" ||
			!vimEnabled ||
			vimModeLabel !== "NORMAL" ||
			cursor.line > model.getLineCount()
		) {
			decorations.set([]);
			return;
		}
		decorations.set(
			charMatchPositions(model.getLinesContent(), phase.char)
				.filter(
					(match) =>
						match.line !== cursor.line || match.column !== cursor.column,
				)
				.map((match) => ({
					range: {
						startLineNumber: match.line,
						startColumn: match.column,
						endLineNumber: match.line,
						endColumn: match.column + 1,
					} as MonacoApi.Range,
					options: { inlineClassName: "qs-match" },
				})),
		);
	}, [activePath, cursor, editorRef, phase, vimEnabled, vimModeLabel]);
}
