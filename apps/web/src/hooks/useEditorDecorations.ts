import { useEffect } from "react";
import type { Monaco } from "@monaco-editor/react";
import type {
	ProbeDescriptor,
	TestCase,
	TestResultEvent,
} from "@atomis/protocol";
import type * as MonacoApi from "monaco-editor";
import { languageForPath } from "../languages.js";
import { displayPreview, type ValueFmt } from "../lowlevel.js";
import {
	primaryDiagnostic,
	problemsByLine,
	severityColor,
	type OwnedDiagnostic,
} from "../state/diagnostics.js";
import { FAILING_STATUSES } from "../state/runSummary.js";
import type { InlineValue } from "../state/runtimeState.js";

interface EditorDecorationOptions {
	editorRef: React.RefObject<
		MonacoApi.editor.IStandaloneCodeEditor | undefined
	>;
	monacoRef: React.RefObject<Monaco | undefined>;
	decorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	errorLensDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	errorLensWidgetsRef: React.RefObject<MonacoApi.editor.IContentWidget[]>;
	testLensDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	testLensWidgetsRef: React.RefObject<MonacoApi.editor.IContentWidget[]>;
	entryRef: React.RefObject<string>;
	activePath: string;
	catalog: ProbeDescriptor[];
	manualProbeIds: string[];
	values: Map<string, InlineValue>;
	stale: boolean;
	valueFmt: ValueFmt;
	allProblems: OwnedDiagnostic[];
	tests: TestCase[];
	testResults: Map<string, TestResultEvent>;
}

/**
 * The three Monaco decoration layers: inline probe values (with the manual
 * probe glyphs), the error lens (diagnostics at end of line) and the test
 * lens (per-test result at its declaration line).
 */
export function useEditorDecorations(options: EditorDecorationOptions): void {
	const {
		editorRef,
		monacoRef,
		decorationsRef,
		errorLensDecorationsRef,
		errorLensWidgetsRef,
		testLensDecorationsRef,
		testLensWidgetsRef,
		entryRef,
		activePath,
		catalog,
		manualProbeIds,
		values,
		stale,
		valueFmt,
		allProblems,
		tests,
		testResults,
	} = options;

	useEffect(() => {
		const editor = editorRef.current;
		const decorations = decorationsRef.current;
		if (!editor || !decorations) return;
		const model = editor.getModel();
		const lineCount = model?.getLineCount() ?? 0;
		const descriptors: MonacoApi.editor.IModelDeltaDecoration[] = catalog
			.filter(
				(probe) =>
					probe.supported &&
					((probe as ProbeDescriptor & { path?: string }).path ??
						`src/${entryRef.current}`) === `src/${activePath}` &&
					probe.originalRange.startLine <= lineCount,
			)
			.map((probe) => {
				const selected = manualProbeIds.includes(probe.probeId);
				const value =
					probe.insertionByte !== undefined
						? values.get(probe.probeId)
						: undefined;
				const content = value
					? `  ${displayPreview(value, valueFmt, languageForPath(activePath))} : ${value.typeName}${value.count > 1 ? ` ×${value.count}` : ""}`
					: "";
				const endColumn =
					model?.getLineMaxColumn(probe.originalRange.startLine) ??
					probe.originalRange.endColumn;
				return {
					range: {
						startLineNumber: probe.originalRange.startLine,
						startColumn: Math.max(1, endColumn - 1),
						endLineNumber: probe.originalRange.startLine,
						endColumn,
					} as MonacoApi.Range,
					options: {
						glyphMarginClassName: selected
							? "manual-probe enabled"
							: "manual-probe",
						glyphMarginHoverMessage: {
							value: selected
								? "Manual probe enabled"
								: "Click to toggle a manual probe",
						},
						...(content
							? {
									after: {
										content,
										inlineClassName: stale
											? "inline-value stale"
											: "inline-value",
										inlineClassNameAffectsLetterSpacing: true,
									},
									hoverMessage: {
										value: `**${value?.name}**: \`${value?.typeName}\`\n\n${value?.history.map((entry) => `- \`${entry}\``).join("\n") ?? ""}`,
									},
								}
							: {}),
					},
				};
			});
		decorations.set(descriptors);
	}, [
		activePath,
		catalog,
		decorationsRef,
		editorRef,
		entryRef,
		manualProbeIds,
		stale,
		values,
		valueFmt,
	]);

	useEffect(() => {
		const editor = editorRef.current;
		const decorations = errorLensDecorationsRef.current;
		const monaco = monacoRef.current;
		const model = editor?.getModel();
		if (!editor || !decorations || !monaco || !model) return;

		const byLine = problemsByLine(allProblems, {
			activePath,
			entryFile: entryRef.current,
			lineCount: model.getLineCount(),
		});

		for (const widget of errorLensWidgetsRef.current)
			editor.removeContentWidget(widget);
		const nextWidgets: MonacoApi.editor.IContentWidget[] = [];

		decorations.set(
			[...byLine.entries()].map(([line, lineDiagnostics]) => {
				const primary = primaryDiagnostic(lineDiagnostics);
				const message = lineDiagnostics
					.map((item) =>
						item.code === undefined
							? item.message
							: `${String(item.code)}: ${item.message}`,
					)
					.join("  •  ");
				const color = severityColor(primary.severity);
				const endColumn = model.getLineMaxColumn(line);
				const messageNode = document.createElement("span");
				messageNode.className = `error-lens-message error-lens-message-${primary.severity}`;
				messageNode.textContent = `${primary.severity === "error" ? "×" : "△"} ${message}`;
				messageNode.title = `${primary.owner} — ${message}`;
				const widget: MonacoApi.editor.IContentWidget = {
					getId: () => `atomis.errorLens.${line}`,
					getDomNode: () => messageNode,
					getPosition: () => ({
						position: { lineNumber: line, column: endColumn },
						preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
					}),
				};
				nextWidgets.push(widget);
				editor.addContentWidget(widget);
				return {
					range: {
						startLineNumber: line,
						startColumn: endColumn,
						endLineNumber: line,
						endColumn,
					} as MonacoApi.Range,
					options: {
						isWholeLine: true,
						showIfCollapsed: true,
						stickiness:
							monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
						className: `error-lens-line error-lens-${primary.severity}`,
						linesDecorationsClassName: `error-lens-glyph error-lens-glyph-${primary.severity}`,
						hoverMessage: { value: `**${primary.owner}** — ${message}` },
						overviewRuler: {
							color,
							position: monaco.editor.OverviewRulerLane.Right,
						},
					},
				};
			}),
		);
		errorLensWidgetsRef.current = nextWidgets;
		return () => {
			for (const widget of nextWidgets) editor.removeContentWidget(widget);
		};
	}, [
		activePath,
		allProblems,
		editorRef,
		entryRef,
		errorLensDecorationsRef,
		errorLensWidgetsRef,
		monacoRef,
	]);

	useEffect(() => {
		const editor = editorRef.current;
		const decorations = testLensDecorationsRef.current;
		const monaco = monacoRef.current;
		const model = editor?.getModel();
		if (!editor || !decorations || !monaco || !model) return;
		for (const widget of testLensWidgetsRef.current)
			editor.removeContentWidget(widget);
		const diagnosticLines = new Set(
			allProblems
				.filter(
					(problem) =>
						(problem.path ?? `src/${entryRef.current}`) ===
						`src/${activePath}`,
				)
				.map((problem) => problem.line),
		);
		const nextWidgets: MonacoApi.editor.IContentWidget[] = [];
		const descriptors: MonacoApi.editor.IModelDeltaDecoration[] = [];
		for (const test of tests) {
			if (test.path !== `src/${activePath}` || test.line > model.getLineCount())
				continue;
			const result = testResults.get(test.testId);
			const failing = result && FAILING_STATUSES.has(result.status);
			const endColumn = model.getLineMaxColumn(test.line);
			if (result && !diagnosticLines.has(test.line)) {
				const label = failing
					? `✗ ${(result.message ?? "test fallando").split("\n")[0] ?? ""}`
					: result.status === "skipped"
						? "− saltado"
						: `✓ ${result.durationMs < 0.05 ? "ok" : `${result.durationMs.toFixed(1)}ms`}`;
				const messageNode = document.createElement("span");
				messageNode.className = `test-lens-message${failing ? " failed" : ""}`;
				messageNode.textContent = label;
				messageNode.title = result.message ?? test.name;
				const widget: MonacoApi.editor.IContentWidget = {
					getId: () => `atomis.testLens.${test.testId}`,
					getDomNode: () => messageNode,
					getPosition: () => ({
						position: { lineNumber: test.line, column: endColumn },
						preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
					}),
				};
				nextWidgets.push(widget);
				editor.addContentWidget(widget);
			}
			descriptors.push({
				range: {
					startLineNumber: test.line,
					startColumn: 1,
					endLineNumber: test.line,
					endColumn,
				} as MonacoApi.Range,
				options: {
					isWholeLine: true,
					stickiness:
						monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					...(failing ? { className: "test-lens-line-failed" } : {}),
					lineNumberClassName: failing
						? "test-line-number failed"
						: "test-line-number",
					...(result?.message
						? {
								hoverMessage: {
									value: `**${test.name}**\n\n\`\`\`\n${result.message}\n\`\`\``,
								},
							}
						: {}),
				},
			});
		}
		decorations.set(descriptors);
		testLensWidgetsRef.current = nextWidgets;
		return () => {
			for (const widget of nextWidgets) editor.removeContentWidget(widget);
		};
	}, [
		activePath,
		allProblems,
		editorRef,
		entryRef,
		monacoRef,
		testLensDecorationsRef,
		testLensWidgetsRef,
		tests,
		testResults,
	]);
}
