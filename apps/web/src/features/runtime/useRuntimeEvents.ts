import { useCallback, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import type {
	AppDiagnostic,
	Dependency,
	DepsState,
	ProbeDescriptor,
	RunResult,
	RunState,
	RuntimeServerEvent,
	TestCase,
	TestResultEvent,
	TestSummaryEvent,
} from "@atomis/protocol";
import type * as MonacoApi from "monaco-editor";
import {
	diagnosticDocPath,
	type ProjectDiagnostic,
} from "../../shared/lib/diagnostics.js";
import {
	finishedRunEntry,
	shouldAutoOpenDrawer,
	type RunHistoryEntry,
} from "../../shared/lib/runSummary.js";
import {
	acceptsVersion,
	updateInlineValue,
	type InlineValue,
} from "../../shared/lib/runtimeState.js";
import { applyRemotePreferences } from "../../shared/stores/storage.js";
import type { LogSourceLocation, ProjectFile, ProjectFilesReader, TerminalEntry } from "../../shared/types.js";

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
	filesRef: ProjectFilesReader;
	setProjectFiles: (
		next: ProjectFile[] | ((previous: ProjectFile[]) => ProjectFile[]),
	) => void;
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
		setProjectFiles,
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
	const [deps, setDeps] = useState<Dependency[]>([]);
	const [depsSupported, setDepsSupported] = useState(false);
	const [depsManifest, setDepsManifest] = useState<string>();
	const [depsHint, setDepsHint] = useState<string>();
	const [depsUntrusted, setDepsUntrusted] = useState(false);
	const [depsState, setDepsState] = useState<DepsState>("idle");
	const [depsError, setDepsError] = useState<string>();
	const [depsOutput, setDepsOutput] = useState<string[]>([]);
	const [openFolds, setOpenFolds] = useState<Set<string>>(new Set());
	const lastRunFailedRef = useRef(false);
	const runNoRef = useRef(0);

	const handleRuntimeEvent = useCallback(
		(event: RuntimeServerEvent): void => {
			// Not session state: a setting someone changed on another device.
			// It carries no documentVersion, so handle it before the gate.
			if (event.type === "preferences.changed") {
				applyRemotePreferences(event.preferences);
				return;
			}
			const projectEvent = event as object as {
				type: "project.files";
				documentVersion: number;
				files: ProjectFile[];
			};
			if (projectEvent.type === "project.files") {
				if (!acceptsVersion(versionRef.current, projectEvent.documentVersion))
					return;
				setProjectFiles(projectEvent.files);
				return;
			}
			if (
				"documentVersion" in event &&
				!acceptsVersion(versionRef.current, event.documentVersion)
			)
				return;
			if (event.type === "run.state") {
				setRunState(event.state);
				// A run that reached the end is showing you the current code,
				// whether or not it had any values to report. Clearing this
				// only when a probe value arrived left a program whose only
				// feedback is a log struck through for good, which reads as
				// "still broken" long after it was fixed.
				if (event.state === "succeeded") setStale(false);
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
						"atomis-instrumenter": [],
					}));
					const monaco = monacoRef.current;
					if (monaco)
						for (const model of monaco.editor.getModels())
							for (const owner of [
								"compiler",
								"runtime",
								"atomis-instrumenter",
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
			} else if (event.type === "deps.catalog") {
				setDeps(event.dependencies);
				setDepsSupported(event.supported);
				setDepsManifest(event.manifest);
				setDepsHint(event.inputHint);
				setDepsUntrusted(event.runsUntrustedCode);
			} else if (event.type === "deps.state") {
				setDepsState(event.state);
				setDepsError(event.error);
				// A fresh run starts with a clean log.
				if (event.state === "installing" || event.state === "removing")
					setDepsOutput([]);
			} else if (event.type === "deps.output") {
				setDepsOutput((previous) =>
					[...previous, event.chunk].slice(-200),
				);
			} else if (event.type === "server.error") setStatus(event.message);
		},
		[
			entryRef,
			filesRef,
			logSourceDecorationsRef,
			monacoRef,
			pinnedLogLocationRef,
			setProjectFiles,
			setStatus,
			versionRef,
		],
	);

	/// Clears everything the previous session produced. Used when the app
	/// switches workspaces without reloading the page.
	const reset = useCallback((): void => {
		setRunState("idle");
		setCatalog([]);
		catalogRef.current = [];
		setValues(new Map());
		setStale(false);
		setOutput([]);
		setDiagnostics({});
		setResult(undefined);
		setTests([]);
		setTestResults(new Map());
		setTestSummary(undefined);
		testSummaryRef.current = undefined;
		setHistory([]);
		setDrawer(false);
		setDeps([]);
		setDepsSupported(false);
		setDepsState("idle");
		setDepsError(undefined);
		setDepsOutput([]);
		setOpenFolds(new Set());
		lastRunFailedRef.current = false;
		runNoRef.current = 0;
	}, []);

	return {
		reset,
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
		deps,
		depsSupported,
		depsManifest,
		depsHint,
		depsUntrusted,
		depsState,
		depsError,
		depsOutput,
		openFolds,
		setOpenFolds,
		handleRuntimeEvent,
	};
}
