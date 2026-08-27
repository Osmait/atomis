import { useCallback, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import type {
	AppDiagnostic,
	ProbeDescriptor,
	RunResult,
	RunState,
	RuntimeServerEvent,
	TestCase,
	TestResultEvent,
	TestSummaryEvent,
} from "@ziglive/protocol";
import type * as MonacoApi from "monaco-editor";
import {
	diagnosticDocPath,
	type ProjectDiagnostic,
} from "../state/diagnostics.js";
import {
	finishedRunEntry,
	shouldAutoOpenDrawer,
	type RunHistoryEntry,
} from "../state/runSummary.js";
import {
	acceptsVersion,
	updateInlineValue,
	type InlineValue,
} from "../state/runtimeState.js";
import type { LogSourceLocation, ProjectFile, TerminalEntry } from "../types.js";

function markerSeverity(
	monaco: Monaco,
	severity: AppDiagnostic["severity"],
): MonacoApi.MarkerSeverity {
	return {
		error: monaco.MarkerSeverity.Error,
		warning: monaco.MarkerSeverity.Warning,
		information: monaco.MarkerSeverity.Info,
		hint: monaco.MarkerSeverity.Hint,
	}[severity];
}

interface RuntimeEventsOptions {
	versionRef: React.RefObject<number>;
	filesRef: React.RefObject<ProjectFile[]>;
	setFiles: (files: ProjectFile[]) => void;
	monacoRef: React.RefObject<Monaco | undefined>;
	entryRef: React.RefObject<string>;
	pinnedLogLocationRef: React.RefObject<LogSourceLocation | undefined>;
	logSourceDecorationsRef: React.RefObject<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>;
	setStatus: (status: string) => void;
}

/**
 * Owns every piece of state fed by the runtime WebSocket — run state, probe
 * catalog/values, terminal output, diagnostics, tests and run history — and
 * the `handleRuntimeEvent` dispatcher that updates it, gated on the current
 * document version.
 */
export function useRuntimeEvents(options: RuntimeEventsOptions) {
	const {
		versionRef,
		filesRef,
		setFiles,
		monacoRef,
		entryRef,
		pinnedLogLocationRef,
		logSourceDecorationsRef,
		setStatus,
	} = options;
	const [runState, setRunState] = useState<RunState>("idle");
	const [catalog, setCatalog] = useState<ProbeDescriptor[]>([]);
	const catalogRef = useRef<ProbeDescriptor[]>([]);
	const [values, setValues] = useState<Map<string, InlineValue>>(new Map());
	const valuesRef = useRef(values);
	valuesRef.current = values;
	const [stale, setStale] = useState(false);
	const [output, setOutput] = useState<TerminalEntry[]>([]);
	const [diagnostics, setDiagnostics] = useState<
		Record<string, ProjectDiagnostic[]>
	>({});
	const [result, setResult] = useState<RunResult>();
	const [tests, setTests] = useState<TestCase[]>([]);
	const [testResults, setTestResults] = useState<Map<string, TestResultEvent>>(
		new Map(),
	);
	const [testSummary, setTestSummary] = useState<TestSummaryEvent>();
	const testSummaryRef = useRef<TestSummaryEvent | undefined>(undefined);
	const [history, setHistory] = useState<RunHistoryEntry[]>([]);
	const [drawer, setDrawer] = useState(false);
	const [openFolds, setOpenFolds] = useState<Set<string>>(new Set());
	const lastRunFailedRef = useRef(false);
	const runNoRef = useRef(0);

	const handleRuntimeEvent = useCallback(
		(event: RuntimeServerEvent): void => {
			const projectEvent = event as object as {
				type: "project.files";
				documentVersion: number;
				files: ProjectFile[];
			};
			if (projectEvent.type === "project.files") {
				if (!acceptsVersion(versionRef.current, projectEvent.documentVersion))
					return;
				filesRef.current = projectEvent.files;
				setFiles(projectEvent.files);
				return;
			}
			if (
				"documentVersion" in event &&
				!acceptsVersion(versionRef.current, event.documentVersion)
			)
				return;
			if (event.type === "run.state") {
				setRunState(event.state);
				if (event.state === "instrumenting") {
					setOutput([]);
					pinnedLogLocationRef.current = undefined;
					logSourceDecorationsRef.current?.clear();
					setResult(undefined);
					setTestResults(new Map());
					setTestSummary(undefined);
					testSummaryRef.current = undefined;
					setOpenFolds(new Set());
					setDiagnostics((previous) => ({
						...previous,
						compiler: [],
						runtime: [],
						"ziglive-instrumenter": [],
					}));
					const monaco = monacoRef.current;
					if (monaco)
						for (const model of monaco.editor.getModels())
							for (const owner of [
								"compiler",
								"runtime",
								"ziglive-instrumenter",
							])
								monaco.editor.setModelMarkers(model, owner, []);
				}
			} else if (event.type === "probe.catalog") {
				catalogRef.current = event.probes;
				setCatalog(event.probes);
			} else if (event.type === "probe_value") {
				setValues((previous) => updateInlineValue(previous, event));
				setStale(false);
			} else if (event.type === "output") {
				const sourceLocation = event.sourceLocation as
					| LogSourceLocation
					| undefined;
				setOutput((previous) =>
					[
						...previous,
						{
							stream: event.stream,
							category: event.category,
							chunk: event.chunk,
							receivedAt: performance.now(),
							...(sourceLocation ? { sourceLocation } : {}),
						},
					].slice(-500),
				);
			} else if (event.type === "diagnostics") {
				const projectDiagnostics = event.diagnostics as ProjectDiagnostic[];
				setDiagnostics((previous) => ({
					...previous,
					[event.owner]: projectDiagnostics,
				}));
				const monaco = monacoRef.current;
				if (monaco)
					for (const file of filesRef.current) {
						const model = monaco.editor.getModel(monaco.Uri.parse(file.uri));
						if (!model) continue;
						const path = `src/${file.path}`;
						monaco.editor.setModelMarkers(
							model,
							event.owner,
							projectDiagnostics
								.filter(
									(item) => diagnosticDocPath(item, entryRef.current) === path,
								)
								.map((item) => ({
									message: item.message,
									severity: markerSeverity(monaco, item.severity),
									source: item.source ?? event.owner,
									startLineNumber: item.line,
									startColumn: item.column,
									endLineNumber: item.endLine ?? item.line,
									endColumn: item.endColumn ?? item.column + 1,
								})),
						);
					}
			} else if (event.type === "test.catalog") setTests(event.tests);
			else if (event.type === "test.result")
				setTestResults((previous) =>
					new Map(previous).set(event.testId ?? event.name, event),
				);
			else if (event.type === "test.summary") {
				testSummaryRef.current = event;
				setTestSummary(event);
			} else if (event.type === "run.finished") {
				setResult(event.result);
				if (!event.result.cancelled) {
					const summary = testSummaryRef.current;
					setHistory((previous) =>
						[
							finishedRunEntry(++runNoRef.current, event.result, summary),
							...previous,
						].slice(0, 4),
					);
					const { open, failed } = shouldAutoOpenDrawer(
						summary,
						lastRunFailedRef.current,
					);
					if (open) setDrawer(true);
					lastRunFailedRef.current = failed;
				}
			} else if (event.type === "server.error") setStatus(event.message);
		},
		[
			entryRef,
			filesRef,
			logSourceDecorationsRef,
			monacoRef,
			pinnedLogLocationRef,
			setFiles,
			setStatus,
			versionRef,
		],
	);

	return {
		runState,
		catalog,
		catalogRef,
		values,
		valuesRef,
		stale,
		setStale,
		output,
		setOutput,
		diagnostics,
		setDiagnostics,
		result,
		tests,
		testResults,
		testSummary,
		history,
		drawer,
		setDrawer,
		openFolds,
		setOpenFolds,
		handleRuntimeEvent,
	};
}
