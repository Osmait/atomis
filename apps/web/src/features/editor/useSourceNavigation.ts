import { useCallback } from "react";
import type * as MonacoApi from "monaco-editor";
import type { LogSourceLocation } from "../../shared/types.js";

/** What it takes to point the editor at a line and say so. */
export interface SourceNavigationDeps {
	editorRef: React.RefObject<MonacoApi.editor.IStandaloneCodeEditor | undefined>;
	activePathRef: React.RefObject<string>;
	entryRef: React.RefObject<string>;
	logSourceDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	pinnedLogLocationRef: React.RefObject<LogSourceLocation | undefined>;
	selectFile: (path: string) => void;
}

/**
 * Going from something the run said to the line that said it: highlighting a
 * log's source, following a terminal entry back to its file, and jumping to a
 * diagnostic. All three end the same way — move the caret, reveal the line,
 * take the focus — and all three have to wait a tick for the file they asked
 * for to be the file on screen.
 */
export function useSourceNavigation({
	editorRef,
	activePathRef,
	entryRef,
	logSourceDecorationsRef,
	pinnedLogLocationRef,
	selectFile,
}: SourceNavigationDeps): {
	highlightLogSource: (location?: LogSourceLocation, reveal?: boolean) => void;
	onEntryClick: (location: LogSourceLocation) => void;
	jumpToLine: (path: string, line: number, column: number) => void;
} {
	const highlightLogSource = useCallback(
		(location?: LogSourceLocation, reveal = false): void => {
			const editor = editorRef.current;
			const decorations = logSourceDecorationsRef.current;
			const model = editor?.getModel();
			if (!editor || !decorations || !model) return;
			if (
				!location ||
				(location.path && location.path !== `src/${activePathRef.current}`) ||
				location.line > model.getLineCount()
			) {
				decorations.clear();
				return;
			}
			const ranges: MonacoApi.editor.IModelDeltaDecoration[] = [
				{
					range: {
						startLineNumber: location.line,
						startColumn: 1,
						endLineNumber: location.line,
						endColumn: model.getLineMaxColumn(location.line),
					} as MonacoApi.Range,
					options: {
						isWholeLine: true,
						className: "log-source-line",
						linesDecorationsClassName: "log-source-glyph",
					},
				},
			];
			if (
				location.loop &&
				location.loop.line !== location.line &&
				location.loop.line <= model.getLineCount()
			)
				ranges.push({
					range: {
						startLineNumber: location.loop.line,
						startColumn: 1,
						endLineNumber: location.loop.line,
						endColumn: model.getLineMaxColumn(location.loop.line),
					} as MonacoApi.Range,
					options: {
						isWholeLine: true,
						className: "log-loop-line",
						linesDecorationsClassName: "log-loop-glyph",
					},
				});
			decorations.set(ranges);
			if (reveal) {
				editor.setPosition({
					lineNumber: location.line,
					column: location.column,
				});
				editor.revealLineInCenter(location.line);
				editor.focus();
			}
		},
		[activePathRef, editorRef, logSourceDecorationsRef],
	);

	const onEntryClick = useCallback(
		(location: LogSourceLocation): void => {
			const path = (location.path ?? `src/${entryRef.current}`).replace(
				/^src\//,
				"",
			);
			selectFile(path);
			pinnedLogLocationRef.current = location;
			setTimeout(() => highlightLogSource(location, true), 0);
		},
		[entryRef, highlightLogSource, pinnedLogLocationRef, selectFile],
	);

	const jumpToLine = useCallback(
		(path: string, line: number, column: number): void => {
			selectFile(path.replace(/^src\//, ""));
			setTimeout(() => {
				editorRef.current?.setPosition({ lineNumber: line, column });
				editorRef.current?.revealLineInCenter(line);
				editorRef.current?.focus();
			}, 0);
		},
		[editorRef, selectFile],
	);

	return { highlightLogSource, onEntryClick, jumpToLine };
}
