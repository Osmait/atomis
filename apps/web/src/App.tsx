import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
	AppDiagnostic,
	CreateSessionResponse,
	Language,
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
	initVimMode,
	StatusBar as VimStatusBar,
	VimMode,
	type VimAdapterInstance,
} from "monaco-vim";
import { CommandPalette } from "./components/CommandPalette.js";
import { FileIcon, FolderIcon } from "./components/FileIcon.js";
import {
	displayPreview,
	parseIntegerPreview,
	VALUE_FMTS,
	type ValueFmt,
} from "./lowlevel.js";
import { PeekPanel } from "./components/PeekPanel.js";
import { Lucide } from "./components/Lucide.js";
import {
	APP_FONTS,
	APP_SIZES,
	APP_THEMES,
	type AppTheme,
	SettingsModal,
} from "./components/SettingsModal.js";
import {
	ENTRY_FILES,
	languageForPath,
	registerAllLanguages,
	WEB_LANGUAGE_PACKS,
} from "./languages.js";
import { LspClient } from "./lsp/LspClient.js";
import {
	acceptsVersion,
	toggleProbe,
	updateInlineValue,
	type InlineValue,
} from "./state/runtimeState.js";
import { buildTreeRows } from "./state/fileTree.js";
import { groupOutput, type TerminalEntry } from "./state/terminalFolds.js";

interface LogSourceLocation {
	path?: string;
	line: number;
	column: number;
	executionIndex: number;
	loop?: {
		line: number;
		column: number;
		variable: string;
		value: string;
	};
}

interface ProjectFile {
	path: string;
	uri: string;
	source: string;
}

interface Settings {
	autoRun: boolean;
	autoInspect: boolean;
	debounceMs: number;
	timeoutMs: number;
	manualProbeIds: string[];
}

interface OwnedDiagnostic extends AppDiagnostic {
	owner: string;
	path?: string;
}

type ProjectDiagnostic = AppDiagnostic & { path?: string };

interface VimModeWithCommands {
	Vim: {
		defineEx: (name: string, prefix: string, callback: () => void) => void;
		unmap: (keys: string, context?: "normal" | "insert" | "visual") => boolean;
		exitInsertMode: (adapter: unknown) => void;
		exitVisualMode: (adapter: unknown) => void;
	};
}

interface VimAdapterState {
	state?: { vim?: { insertMode?: boolean; visualMode?: boolean } };
}

let vimModeListener: ((mode: string) => void) | undefined;

class NvimStatusBar extends VimStatusBar {
	override setMode(event: { mode: string; subMode?: string }): void {
		const suffix =
			event.mode === "visual" && event.subMode
				? ` ${event.subMode.replace("wise", "").toUpperCase()}`
				: "";
		vimModeListener?.(`${event.mode.toUpperCase()}${suffix}`);
	}
}

const RUN_STATE_LABELS: Record<RunState, string> = {
	idle: "listo",
	debouncing: "esperando",
	instrumenting: "inspeccionando",
	compiling: "compilando",
	running: "ejecutando",
	testing: "tests",
	succeeded: "listo",
	compile_error: "error",
	runtime_error: "error",
	timed_out: "timeout",
	cancelled: "cancelado",
};

const TEST_MARKS: Record<TestResultEvent["status"], string> = {
	passed: "✓",
	failed: "✗",
	skipped: "−",
	leaked: "⚠",
	timed_out: "⏱",
};

interface LayoutState {
	dock: "right" | "bottom";
	treeOpen: boolean;
	termOpen: boolean;
	termMax: boolean;
	zen: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
	dock: "right",
	treeOpen: true,
	termOpen: true,
	termMax: false,
	zen: false,
};
const LAYOUT_KEY = "ziglive.layout.v1";

function loadLayout(): LayoutState {
	try {
		return {
			...DEFAULT_LAYOUT,
			...(JSON.parse(
				localStorage.getItem(LAYOUT_KEY) ?? "{}",
			) as Partial<LayoutState>),
		};
	} catch {
		return DEFAULT_LAYOUT;
	}
}

interface RunHistoryEntry {
	n: number;
	ok: boolean;
	ms: string;
}

const SEVERITY_RANK: Record<AppDiagnostic["severity"], number> = {
	error: 4,
	warning: 3,
	information: 2,
	hint: 1,
};

const DEFAULT_SETTINGS: Settings = {
	autoRun: true,
	autoInspect: true,
	debounceMs: 400,
	timeoutMs: 2000,
	manualProbeIds: [],
};
const SETTINGS_KEY = "ziglive.settings.v1";
const VALUE_FMT_KEY = "ziglive.value-fmt.v1";
const APPEARANCE_KEY = "ziglive.appearance.v1";

interface Appearance {
	theme: AppTheme;
	fontIndex: number;
	sizeIndex: number;
}

function loadAppearance(): Appearance {
	try {
		const stored = JSON.parse(
			localStorage.getItem(APPEARANCE_KEY) ?? "{}",
		) as Partial<Appearance>;
		return {
			theme: APP_THEMES.some((entry) => entry.id === stored.theme)
				? (stored.theme as AppTheme)
				: "mocha",
			fontIndex:
				typeof stored.fontIndex === "number" &&
				stored.fontIndex >= 0 &&
				stored.fontIndex < APP_FONTS.length
					? stored.fontIndex
					: 0,
			sizeIndex:
				typeof stored.sizeIndex === "number" &&
				stored.sizeIndex >= 0 &&
				stored.sizeIndex < APP_SIZES.length
					? stored.sizeIndex
					: 1,
		};
	} catch {
		return { theme: "mocha", fontIndex: 0, sizeIndex: 1 };
	}
}
const SOURCE_KEY = "ziglive.source.v1";
const VIM_MODE_KEY = "ziglive.vim-mode.v1";
const LANGUAGE_KEY = "ziglive.language.v1";

function loadLanguage(): Language {
	const stored = localStorage.getItem(LANGUAGE_KEY);
	return stored && stored in WEB_LANGUAGE_PACKS ? (stored as Language) : "zig";
}

function loadValueFmt(): ValueFmt {
	const stored = localStorage.getItem(VALUE_FMT_KEY);
	return VALUE_FMTS.includes(stored as ValueFmt) ? (stored as ValueFmt) : "dec";
}

function loadSettings(): Settings {
	try {
		return {
			...DEFAULT_SETTINGS,
			...(JSON.parse(
				localStorage.getItem(SETTINGS_KEY) ?? "{}",
			) as Partial<Settings>),
			manualProbeIds: [],
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}

function websocketUrl(
	path: string,
	session: CreateSessionResponse,
	params: Record<string, string> = {},
): string {
	const url = new URL(path, window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("sessionId", session.sessionId);
	url.searchParams.set("token", session.authToken);
	for (const [key, value] of Object.entries(params))
		url.searchParams.set(key, value);
	return url.href;
}

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

export function App(): React.JSX.Element {
	const entryRef = useRef("main.zig");
	const [session, setSession] = useState<CreateSessionResponse>();
	const [files, setFiles] = useState<ProjectFile[]>([]);
	const [activePath, setActivePath] = useState(entryRef.current);
	const [openTabs, setOpenTabs] = useState([entryRef.current]);
	const [startupError, setStartupError] = useState<string>();
	const [settings, setSettings] = useState<Settings>(loadSettings);
	const [valueFmt, setValueFmt] = useState<ValueFmt>(loadValueFmt);
	const [peek, setPeek] = useState<{ path: string; probeId: string } | null>(
		null,
	);
	const [peekOverride, setPeekOverride] = useState<bigint | undefined>(
		undefined,
	);
	const [peekNode, setPeekNode] = useState<HTMLDivElement | null>(null);
	const [drawer, setDrawer] = useState(false);
	const [drawerTab, setDrawerTab] = useState<"tests" | "hist">("tests");
	const [termMenuOpen, setTermMenuOpen] = useState(false);
	const [treeMenuOpen, setTreeMenuOpen] = useState(false);
	const [treeContextMenu, setTreeContextMenu] = useState<
		| { x: number; y: number; path?: string; folder?: string }
		| undefined
	>(undefined);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
	const [runState, setRunState] = useState<RunState>("idle");
	const [status, setStatus] = useState("Starting…");
	const [catalog, setCatalog] = useState<ProbeDescriptor[]>([]);
	const [values, setValues] = useState<Map<string, InlineValue>>(new Map());
	const valuesRef = useRef(values);
	valuesRef.current = values;
	const [stale, setStale] = useState(false);
	const [output, setOutput] = useState<
		{
			stream: "stdout" | "stderr";
			category: "program" | "error";
			chunk: string;
			receivedAt: number;
			sourceLocation?: LogSourceLocation;
		}[]
	>([]);
	const [diagnostics, setDiagnostics] = useState<
		Record<string, AppDiagnostic[]>
	>({});
	const [result, setResult] = useState<RunResult>();
	const [tab, setTab] = useState<"output" | "problems" | "runtime">("output");
	const [capabilities, setCapabilities] = useState<
		Partial<Record<Language, Record<string, unknown>>>
	>({});
	const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
	const [vimEnabled, setVimEnabled] = useState(
		() => localStorage.getItem(VIM_MODE_KEY) !== "false",
	);
	const [editorContextMenu, setEditorContextMenu] = useState<{
		x: number;
		y: number;
	}>();
	const [layout, setLayout] = useState<LayoutState>(loadLayout);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [tests, setTests] = useState<TestCase[]>([]);
	const [testResults, setTestResults] = useState<Map<string, TestResultEvent>>(
		new Map(),
	);
	const [testSummary, setTestSummary] = useState<TestSummaryEvent>();
	const [openFolds, setOpenFolds] = useState<Set<string>>(new Set());
	const [history, setHistory] = useState<RunHistoryEntry[]>([]);
	const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
		new Set(),
	);
	const [pendingFolders, setPendingFolders] = useState<string[]>([]);
	const [narrow, setNarrow] = useState(false);
	const [tight, setTight] = useState(false);
	const [vimModeLabel, setVimModeLabel] = useState("NORMAL");
	const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | undefined>(
		undefined,
	);
	const monacoRef = useRef<Monaco | undefined>(undefined);
	const runtimeRef = useRef<WebSocket | undefined>(undefined);
	const lspClientsRef = useRef<Partial<Record<Language, LspClient>>>({});
	const sessionRef = useRef<CreateSessionResponse | undefined>(undefined);
	const activeLanguageRef = useRef<Language>("zig");
	const vimRef = useRef<VimAdapterInstance | null>(null);
	const vimStatusRef = useRef<HTMLDivElement | null>(null);
	const vimEnabledRef = useRef(vimEnabled);
	const decorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const errorLensDecorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const logSourceDecorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const pinnedLogLocationRef = useRef<LogSourceLocation | undefined>(undefined);
	const errorLensWidgetsRef = useRef<MonacoApi.editor.IContentWidget[]>([]);
	const versionRef = useRef(1);
	const filesRef = useRef<ProjectFile[]>([]);
	const activePathRef = useRef(entryRef.current);
	const lastRunLanguageRef = useRef<Language | null>(null);
	const lastRunFailedRef = useRef(false);
	const settingsRef = useRef(settings);
	const catalogRef = useRef<ProbeDescriptor[]>([]);
	const testLensDecorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const testLensWidgetsRef = useRef<MonacoApi.editor.IContentWidget[]>([]);
	const testSummaryRef = useRef<TestSummaryEvent | undefined>(undefined);
	const runNoRef = useRef(0);
	const allProblems = useMemo<OwnedDiagnostic[]>(() => {
		const seen = new Set<string>();
		return Object.entries(diagnostics).flatMap(([owner, items]) =>
			items.flatMap((item) => {
				const key = `${item.severity}:${item.line}:${item.column}:${item.message}`;
				if (seen.has(key)) return [];
				seen.add(key);
				return [{ owner, ...item }];
			}),
		);
	}, [diagnostics]);

	useEffect(() => {
		if (!editorContextMenu) return;
		const closeOnPointer = (event: PointerEvent): void => {
			if (
				event.target instanceof Element &&
				event.target.closest(".editor-context-menu")
			)
				return;
			setEditorContextMenu(undefined);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setEditorContextMenu(undefined);
		};
		window.addEventListener("pointerdown", closeOnPointer);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("pointerdown", closeOnPointer);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [editorContextMenu]);

	useEffect(() => {
		void fetch("/api/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ language: loadLanguage() }),
		})
			.then(async (response) => {
				if (!response.ok)
					throw new Error(`Session creation failed (${response.status})`);
				return (await response.json()) as CreateSessionResponse;
			})
			.then((created) => {
				sessionRef.current = created;
				const entry = WEB_LANGUAGE_PACKS[created.language].entryFile;
				entryRef.current = entry;
				activeLanguageRef.current = created.language;
				activePathRef.current = entry;
				setActivePath(entry);
				setOpenTabs([entry]);
				const projectFiles = (
					created as CreateSessionResponse & { files?: ProjectFile[] }
				).files ?? [
					{
						path: entry,
						uri: created.documentUri,
						source: created.initialSource,
					},
				];
				filesRef.current = projectFiles;
				setFiles(projectFiles);
				setSession(created);
			})
			.catch((error: unknown) =>
				setStartupError(error instanceof Error ? error.message : String(error)),
			);
	}, []);

	const sendRuntime = useCallback((message: object): void => {
		if (runtimeRef.current?.readyState === WebSocket.OPEN)
			runtimeRef.current.send(JSON.stringify(message));
	}, []);

	const sendSettings = useCallback(
		(next: Settings): void => {
			settingsRef.current = next;
			setSettings(next);
			localStorage.setItem(
				SETTINGS_KEY,
				JSON.stringify({ ...next, manualProbeIds: [] }),
			);
			if (session)
				sendRuntime({
					type: "settings.update",
					sessionId: session.sessionId,
					...next,
				});
		},
		[sendRuntime, session],
	);

	const updateAppearance = useCallback((next: Partial<Appearance>): void => {
		setAppearance((previous) => {
			const merged = { ...previous, ...next };
			localStorage.setItem(APPEARANCE_KEY, JSON.stringify(merged));
			return merged;
		});
	}, []);

	const run = useCallback((): void => {
		if (!session) return;
		const language =
			languageForPath(activePathRef.current) ?? activeLanguageRef.current;
		lastRunLanguageRef.current = language;
		sendRuntime({
			type: "run.request",
			sessionId: session.sessionId,
			version: versionRef.current,
			reason: "manual",
			language,
		});
	}, [sendRuntime, session]);
	const stop = useCallback((): void => {
		if (session)
			sendRuntime({ type: "run.cancel", sessionId: session.sessionId });
	}, [sendRuntime, session]);

	// Probe/test state holds the LAST run's language only: entering a file of
	// a different language would show nothing until an edit re-ran it. Kick
	// an automatic run for the newly active language instead.
	useEffect(() => {
		if (!session) return;
		const language = languageForPath(activePath);
		if (!language) return;
		const last = lastRunLanguageRef.current ?? session.language;
		if (language === last) return;
		if (!settingsRef.current.autoRun) return;
		if (session.degraded[language]) return;
		const timer = setTimeout(run, 80);
		return () => clearTimeout(timer);
	}, [activePath, session, run]);

	const changeVimMode = useCallback((enabled: boolean): void => {
		vimEnabledRef.current = enabled;
		setVimEnabled(enabled);
		localStorage.setItem(VIM_MODE_KEY, String(enabled));
		vimRef.current?.dispose();
		vimRef.current = null;
		if (enabled && editorRef.current && vimStatusRef.current)
			vimRef.current = initVimMode(
				editorRef.current,
				vimStatusRef.current,
				NvimStatusBar,
			);
		editorRef.current?.focus();
	}, []);

	const copyFromEditor = useCallback(async (): Promise<void> => {
		setEditorContextMenu(undefined);
		const editor = editorRef.current;
		const model = editor?.getModel();
		const selection = editor?.getSelection();
		if (!editor || !model || !selection) return;
		const text = selection.isEmpty()
			? model.getLineContent(selection.startLineNumber)
			: model.getValueInRange(selection);
		try {
			await navigator.clipboard.writeText(text);
		} catch (error) {
			setStatus(
				`Copy failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		editor.focus();
	}, []);

	const pasteIntoEditor = useCallback(async (): Promise<void> => {
		setEditorContextMenu(undefined);
		const editor = editorRef.current;
		if (!editor) return;
		editor.focus();
		const selection = editor.getSelection();
		if (!selection) return;
		try {
			const text = await navigator.clipboard.readText();
			editor.executeEdits("ziglive.clipboard", [
				{ range: selection, text, forceMoveMarkers: true },
			]);
		} catch (error) {
			setStatus(
				`Paste failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		editor.focus();
	}, []);

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
		[],
	);

	const handleRuntimeEvent = useCallback((event: RuntimeServerEvent): void => {
		const projectEvent = event as unknown as {
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
							.filter((item) => (item.path ?? `src/${entryRef.current}`) === path)
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
				const ok =
					event.result.exitCode === 0 &&
					!event.result.timedOut &&
					(summary ? summary.failed === 0 && summary.leaked === 0 : true);
				const entry: RunHistoryEntry = {
					n: ++runNoRef.current,
					ok,
					ms: `${event.result.executionMs.toFixed(1)}ms`,
				};
				setHistory((previous) => [entry, ...previous].slice(0, 4));
				// Open the drawer when tests START failing; if the user closes it
				// while still red, later failing runs must not force it back open.
				const failedTests = Boolean(
					summary && (summary.failed > 0 || summary.leaked > 0),
				);
				if (failedTests && !lastRunFailedRef.current) setDrawer(true);
				lastRunFailedRef.current = failedTests;
			}
		} else if (event.type === "server.error") setStatus(event.message);
	}, []);

	const ensureLspClient = useCallback(
		(
			language: Language,
			model: MonacoApi.editor.ITextModel,
		): LspClient | undefined => {
			const existing = lspClientsRef.current[language];
			if (existing) return existing;
			const monaco = monacoRef.current;
			const created = sessionRef.current;
			if (!monaco || !created) return undefined;
			const workspaceUri = created.documentUri.slice(
				0,
				created.documentUri.lastIndexOf("/"),
			);
			const pack = WEB_LANGUAGE_PACKS[language];
			const serverName = pack.serverName;
			const client = new LspClient(
				monaco,
				model,
				workspaceUri,
				(capabilitiesResult) =>
					setCapabilities((previous) => ({
						...previous,
						[language]: capabilitiesResult,
					})),
				(uri, items) => {
					const path = filesRef.current.find(
						(file) => file.uri === uri,
					)?.path;
					setDiagnostics((previous) => ({
						...previous,
						[`${serverName}:${path ?? uri}`]: items.map((item) => ({
							...(path ? { path: `src/${path}` } : {}),
							message: item.message,
							severity:
								item.severity === 2
									? ("warning" as const)
									: item.severity === 3
										? ("information" as const)
										: item.severity === 4
											? ("hint" as const)
											: ("error" as const),
							line: item.range.start.line + 1,
							column: item.range.start.character + 1,
							endLine: item.range.end.line + 1,
							endColumn: item.range.end.character + 1,
							...(item.code !== undefined ? { code: item.code } : {}),
							source: item.source ?? serverName,
						})),
					}));
				},
				setStatus,
				pack.monacoId,
				serverName,
			);
			lspClientsRef.current[language] = client;
			client.connect(
				websocketUrl("/ws/lsp", created, { lang: language }),
				versionRef.current,
			);
			return client;
		},
		[],
	);

	const openInLsp = useCallback(
		(path: string, model: MonacoApi.editor.ITextModel): void => {
			const language = languageForPath(path);
			if (!language) return;
			const client = ensureLspClient(language, model);
			client?.open(model, versionRef.current);
		},
		[ensureLspClient],
	);

	const handleMount: OnMount = useCallback(
		(editor, monaco) => {
			if (!session) return;
			editorRef.current = editor;
			monacoRef.current = monaco;
			const model = editor.getModel();
			if (!model) return;
			filesRef.current = filesRef.current.map((file) =>
				file.path === entryRef.current ? { ...file, source: model.getValue() } : file,
			);
			decorationsRef.current = editor.createDecorationsCollection();
			errorLensDecorationsRef.current = editor.createDecorationsCollection();
			logSourceDecorationsRef.current = editor.createDecorationsCollection();
			testLensDecorationsRef.current = editor.createDecorationsCollection();
			setCursorPosition({
				line: editor.getPosition()?.lineNumber ?? 1,
				column: editor.getPosition()?.column ?? 1,
			});
			editor.onDidChangeCursorPosition(({ position: nextPosition }) =>
				setCursorPosition({
					line: nextPosition.lineNumber,
					column: nextPosition.column,
				}),
			);

			const runtime = new WebSocket(websocketUrl("/ws/runtime", session));
			runtimeRef.current = runtime;
			runtime.addEventListener("open", () => {
				sendRuntime({
					type: "settings.update",
					sessionId: session.sessionId,
					...settingsRef.current,
				});
				const mainSource =
					filesRef.current.find((file) => file.path === entryRef.current)?.source ??
					session.initialSource;
				if (mainSource !== session.initialSource) {
					versionRef.current = 2;
					sendRuntime({
						type: "document.update",
						sessionId: session.sessionId,
						version: 2,
						path: entryRef.current,
						source: mainSource,
					});
				}
			});
			runtime.addEventListener("message", (message) => {
				try {
					handleRuntimeEvent(
						JSON.parse(String(message.data)) as RuntimeServerEvent,
					);
				} catch (error) {
					setStatus(
						`Runtime protocol error: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
			runtime.addEventListener("close", () =>
				setStatus("Runtime disconnected"),
			);

			openInLsp(activePathRef.current, model);

			editor.onKeyDown((event) => {
				if (
					(event.ctrlKey || event.metaKey) &&
					event.keyCode === monaco.KeyCode.Enter
				) {
					event.preventDefault();
					event.stopPropagation();
					run();
				}
			});
			const editorNode = editor.getContainerDomNode();
			const showContextMenu = (event: MouseEvent): void => {
				event.preventDefault();
				event.stopPropagation();
				setEditorContextMenu({
					x: Math.min(event.clientX, window.innerWidth - 170),
					y: Math.min(event.clientY, window.innerHeight - 90),
				});
			};
			editorNode.addEventListener("contextmenu", showContextMenu, true);
			editor.onDidDispose(() =>
				editorNode.removeEventListener("contextmenu", showContextMenu, true),
			);
			const vimCommands = VimMode as unknown as VimModeWithCommands;
			for (const shortcut of ["<C-a>", "<C-c>", "<C-v>", "<C-x>"])
				vimCommands.Vim.unmap(shortcut);
			vimCommands.Vim.unmap("<C-c>", "insert");
			vimCommands.Vim.defineEx("write", "w", run);
			if (vimEnabledRef.current && vimStatusRef.current)
				vimRef.current = initVimMode(
					editor,
					vimStatusRef.current,
					NvimStatusBar,
				);
			editor.onMouseDown((mouse) => {
				const element = mouse.target.element as HTMLElement | null;
				if (
					element?.classList?.contains("inline-value") &&
					mouse.target.position
				) {
					const line = mouse.target.position.lineNumber;
					const clicked = catalogRef.current.find(
						(candidate) =>
							candidate.supported &&
							candidate.originalRange.startLine === line &&
							((candidate as ProbeDescriptor & { path?: string }).path ??
								`src/${entryRef.current}`) ===
								`src/${activePathRef.current}`,
					);
					if (clicked) {
						setPeek((previous) =>
							previous?.probeId === clicked.probeId
								? null
								: { path: activePathRef.current, probeId: clicked.probeId },
						);
						return;
					}
				}
				if (
					mouse.target.type !==
						monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
					!mouse.target.position
				)
					return;
				const probe = catalogRef.current.find(
					(candidate) =>
						candidate.supported &&
						candidate.originalRange.startLine ===
							mouse.target.position?.lineNumber,
				);
				if (!probe) return;
				const next = {
					...settingsRef.current,
					manualProbeIds: toggleProbe(
						settingsRef.current.manualProbeIds,
						probe.probeId,
					),
				};
				sendSettings(next);
				setTimeout(run, 0);
			});
		},
		[handleRuntimeEvent, openInLsp, run, sendRuntime, sendSettings, session],
	);

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
				const selected = settings.manualProbeIds.includes(probe.probeId);
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
	}, [activePath, catalog, settings.manualProbeIds, stale, values, valueFmt]);

	// ── Peek panel: Monaco view zone + overlay under the probed line ──
	useEffect(() => {
		setPeekOverride(undefined);
		const editor = editorRef.current;
		if (!editor || !peek || peek.path !== activePath) {
			setPeekNode(null);
			return;
		}
		const value = valuesRef.current.get(peek.probeId);
		const model = editor.getModel();
		if (!value || !model || value.line > model.getLineCount()) {
			setPeekNode(null);
			return;
		}
		const overlayNode = document.createElement("div");
		overlayNode.className = "peek-overlay";
		let zoneId = "";
		const zone = {
			afterLineNumber: value.line,
			heightInPx: 120,
			domNode: document.createElement("div"),
			onDomNodeTop: (top: number) => {
				overlayNode.style.top = `${top}px`;
			},
		};
		editor.changeViewZones((accessor) => {
			zoneId = accessor.addZone(zone);
		});
		const layoutOverlay = (): void => {
			const layout = editor.getLayoutInfo();
			overlayNode.style.left = `${layout.contentLeft}px`;
			overlayNode.style.width = `${Math.max(280, layout.contentWidth - 30)}px`;
		};
		layoutOverlay();
		const overlay = {
			getId: () => "ziglive.peek",
			getDomNode: () => overlayNode,
			getPosition: () => null,
		};
		editor.addOverlayWidget(overlay);
		const layoutListener = editor.onDidLayoutChange(layoutOverlay);
		const observer = new ResizeObserver(() => {
			const height = overlayNode.scrollHeight;
			if (height > 0 && height + 10 !== zone.heightInPx) {
				zone.heightInPx = height + 10;
				editor.changeViewZones((accessor) => accessor.layoutZone(zoneId));
			}
		});
		observer.observe(overlayNode);
		setPeekNode(overlayNode);
		editor.revealLineInCenterIfOutsideViewport(value.line);
		return () => {
			observer.disconnect();
			layoutListener.dispose();
			editor.removeOverlayWidget(overlay);
			editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
			setPeekNode(null);
		};
	}, [peek, activePath]);

	// The peek follows the run: close it when its probe stops reporting or
	// the buffer goes stale (lines may have shifted under the zone).
	useEffect(() => {
		if (peek && (stale || !values.has(peek.probeId))) setPeek(null);
	}, [peek, stale, values]);

	useEffect(() => {
		const editor = editorRef.current;
		const decorations = errorLensDecorationsRef.current;
		const monaco = monacoRef.current;
		const model = editor?.getModel();
		if (!editor || !decorations || !monaco || !model) return;

		const byLine = new Map<number, OwnedDiagnostic[]>();
		for (const diagnostic of allProblems) {
			if (
				(diagnostic.path ?? `src/${entryRef.current}`) !== `src/${activePath}` ||
				diagnostic.line < 1 ||
				diagnostic.line > model.getLineCount()
			)
				continue;
			const lineDiagnostics = byLine.get(diagnostic.line) ?? [];
			if (
				!lineDiagnostics.some(
					(item) =>
						item.message === diagnostic.message &&
						item.severity === diagnostic.severity,
				)
			)
				lineDiagnostics.push(diagnostic);
			byLine.set(diagnostic.line, lineDiagnostics);
		}

		for (const widget of errorLensWidgetsRef.current)
			editor.removeContentWidget(widget);
		const nextWidgets: MonacoApi.editor.IContentWidget[] = [];

		decorations.set(
			[...byLine.entries()].map(([line, lineDiagnostics]) => {
				const primary = [...lineDiagnostics].sort(
					(left, right) =>
						SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity],
				)[0]!;
				const message = lineDiagnostics
					.map((item) =>
						item.code === undefined
							? item.message
							: `${String(item.code)}: ${item.message}`,
					)
					.join("  •  ");
				const color =
					primary.severity === "error"
						? "#f14c4c"
						: primary.severity === "warning"
							? "#cca700"
							: "#3794ff";
				const endColumn = model.getLineMaxColumn(line);
				const messageNode = document.createElement("span");
				messageNode.className = `error-lens-message error-lens-message-${primary.severity}`;
				messageNode.textContent = `${primary.severity === "error" ? "×" : "△"} ${message}`;
				messageNode.title = `${primary.owner} — ${message}`;
				const widget: MonacoApi.editor.IContentWidget = {
					getId: () => `ziglive.errorLens.${line}`,
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
	}, [activePath, allProblems]);

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
					(problem) => (problem.path ?? `src/${entryRef.current}`) === `src/${activePath}`,
				)
				.map((problem) => problem.line),
		);
		const nextWidgets: MonacoApi.editor.IContentWidget[] = [];
		const descriptors: MonacoApi.editor.IModelDeltaDecoration[] = [];
		for (const test of tests) {
			if (test.path !== `src/${activePath}` || test.line > model.getLineCount())
				continue;
			const result = testResults.get(test.testId);
			const failing =
				result &&
				(result.status === "failed" ||
					result.status === "leaked" ||
					result.status === "timed_out");
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
					getId: () => `ziglive.testLens.${test.testId}`,
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
						? { hoverMessage: { value: `**${test.name}**\n\n\`\`\`\n${result.message}\n\`\`\`` } }
						: {}),
				},
			});
		}
		decorations.set(descriptors);
		testLensWidgetsRef.current = nextWidgets;
		return () => {
			for (const widget of nextWidgets) editor.removeContentWidget(widget);
		};
	}, [activePath, allProblems, tests, testResults]);

	useEffect(
		() => () => {
			vimRef.current?.dispose();
			for (const client of Object.values(lspClientsRef.current))
				client?.dispose();
			runtimeRef.current?.close();
		},
		[],
	);

	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const paletteOpenRef = useRef(paletteOpen);
	paletteOpenRef.current = paletteOpen;
	const updateLayout = useCallback((patch: Partial<LayoutState>): void => {
		setLayout((previous) => {
			const next = { ...previous, ...patch };
			localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
			return next;
		});
	}, []);
	const toggleZen = useCallback(
		() => updateLayout({ zen: !layoutRef.current.zen }),
		[updateLayout],
	);

	const formatAndNormal = useCallback((): void => {
		const editor = editorRef.current;
		if (!editor) return;
		const vimCommands = VimMode as unknown as VimModeWithCommands;
		const adapter = vimRef.current as unknown as VimAdapterState | null;
		try {
			if (adapter?.state?.vim?.insertMode)
				vimCommands.Vim.exitInsertMode(adapter);
			else if (adapter?.state?.vim?.visualMode)
				vimCommands.Vim.exitVisualMode(adapter);
		} catch {
			// vim state not ready yet; formatting still applies
		}
		void editor.getAction("editor.action.formatDocument")?.run();
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && paletteOpenRef.current) {
				setPaletteOpen(false);
				return;
			}
			const mod = event.metaKey || event.ctrlKey;
			if (!mod) return;
			const key = event.key.toLowerCase();
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				run();
			} else if (event.key === ".") {
				event.preventDefault();
				event.stopPropagation();
				toggleZen();
			} else if (key === "b") {
				event.preventDefault();
				event.stopPropagation();
				updateLayout({ treeOpen: !layoutRef.current.treeOpen, zen: false });
			} else if (key === "j") {
				event.preventDefault();
				event.stopPropagation();
				updateLayout({ termOpen: !layoutRef.current.termOpen, zen: false });
			} else if (key === "k") {
				event.preventDefault();
				event.stopPropagation();
				setPaletteOpen(true);
			} else if (key === "s") {
				event.preventDefault();
				event.stopPropagation();
				formatAndNormal();
			} else if (key === "t") {
				event.preventDefault();
				event.stopPropagation();
				setDrawer((previous) => !previous);
				updateLayout({ termOpen: true, zen: false });
			} else if (event.key === ",") {
				event.preventDefault();
				event.stopPropagation();
				setSettingsOpen((previous) => !previous);
			} else if ("12345".includes(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				const fmt = VALUE_FMTS[Number(event.key) - 1];
				if (fmt) {
					setValueFmt(fmt);
					localStorage.setItem(VALUE_FMT_KEY, fmt);
				}
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [formatAndNormal, run, toggleZen, updateLayout]);

	useEffect(() => {
		if (!termMenuOpen) return;
		const close = (event: PointerEvent): void => {
			if (
				event.target instanceof Element &&
				event.target.closest(".term-menu-wrap")
			)
				return;
			setTermMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setTermMenuOpen(false);
		};
		window.addEventListener("pointerdown", close);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [termMenuOpen]);

	useEffect(() => {
		if (!treeMenuOpen) return;
		const close = (event: PointerEvent): void => {
			if (
				event.target instanceof Element &&
				event.target.closest(".tree-menu-wrap, .tree-menu")
			)
				return;
			setTreeMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setTreeMenuOpen(false);
		};
		window.addEventListener("pointerdown", close);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [treeMenuOpen]);

	useEffect(() => {
		if (!treeContextMenu) return;
		const closeOnPointer = (event: PointerEvent): void => {
			if (
				event.target instanceof Element &&
				event.target.closest(".tree-context-menu")
			)
				return;
			setTreeContextMenu(undefined);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setTreeContextMenu(undefined);
		};
		window.addEventListener("pointerdown", closeOnPointer);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("pointerdown", closeOnPointer);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [treeContextMenu]);

	useEffect(() => {
		const narrowQuery = window.matchMedia("(max-width: 1040px)");
		const tightQuery = window.matchMedia("(max-width: 780px)");
		const update = (): void => {
			setNarrow(narrowQuery.matches);
			setTight(tightQuery.matches);
		};
		update();
		narrowQuery.addEventListener("change", update);
		tightQuery.addEventListener("change", update);
		return () => {
			narrowQuery.removeEventListener("change", update);
			tightQuery.removeEventListener("change", update);
		};
	}, []);

	useEffect(() => {
		vimModeListener = (mode) => setVimModeLabel(mode);
		return () => {
			vimModeListener = undefined;
		};
	}, []);

	useEffect(() => {
		setVimModeLabel(vimEnabled ? "NORMAL" : "EDIT");
	}, [vimEnabled]);

	useEffect(() => {
		monacoRef.current?.editor.setTheme(
			layout.zen ? "ziglive-zen" : "ziglive-dark",
		);
	}, [layout.zen, session]);

	const selectFile = useCallback((path: string): void => {
		const file = filesRef.current.find((candidate) => candidate.path === path);
		if (!file) return;
		activePathRef.current = path;
		setActivePath(path);
		setOpenTabs((previous) =>
			previous.includes(path) ? previous : [...previous, path],
		);
		pinnedLogLocationRef.current = undefined;
		logSourceDecorationsRef.current?.clear();
		const language = languageForPath(path);
		if (language) {
			activeLanguageRef.current = language;
			localStorage.setItem(LANGUAGE_KEY, language);
		}
		setTimeout(() => {
			const model = monacoRef.current?.editor.getModel(
				monacoRef.current.Uri.parse(file.uri),
			);
			if (model) openInLsp(path, model);
		}, 0);
	}, [openInLsp]);

	const createFileNamed = useCallback((path: string): void => {
		if (!session) return;
		if (
			path.startsWith("/") ||
			path.includes("\\") ||
			path.split("/").some((part) => !part || part === "." || part === "..")
		) {
			setStatus("Ruta de archivo inválida");
			return;
		}
		if (filesRef.current.some((file) => file.path === path)) {
			setStatus(`El archivo ${path} ya existe`);
			return;
		}
		const base = session.documentUri.slice(
			0,
			session.documentUri.lastIndexOf("/") + 1,
		);
		const file = { path, uri: new URL(path, base).href, source: "" };
		const nextFiles = [...filesRef.current, file].sort((left, right) =>
			left.path.localeCompare(right.path),
		);
		filesRef.current = nextFiles;
		setFiles(nextFiles);
		const version = ++versionRef.current;
		sendRuntime({
			type: "file.create",
			sessionId: session.sessionId,
			version,
			path,
			source: "",
		});
		activePathRef.current = path;
		setActivePath(path);
		setOpenTabs((previous) => [...previous, path]);
	}, [sendRuntime, session]);

	const createFile = useCallback(
		(prefix = ""): void => {
			const path = window
				.prompt("Ruta del nuevo archivo (relativa a src/):", prefix)
				?.trim();
			if (path) createFileNamed(path);
		},
		[createFileNamed],
	);

	const createFolder = useCallback((): void => {
		const raw = window
			.prompt("Nombre de la carpeta (p. ej. utils o aoc/day1):")
			?.trim();
		if (!raw) return;
		const folder = raw.replace(/\/+$/, "");
		if (
			folder.startsWith("/") ||
			folder.includes("\\") ||
			folder
				.split("/")
				.some((part) => !part || part === "." || part === "..")
		) {
			setStatus("Nombre de carpeta inválido");
			return;
		}
		setPendingFolders((previous) =>
			previous.includes(folder) ? previous : [...previous, folder],
		);
	}, []);

	const toggleFolder = useCallback((path: string): void => {
		setCollapsedFolders((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const closeTab = useCallback(
		(path: string): void => {
			const remaining = openTabs.filter((tab) => tab !== path);
			const next = remaining.length ? remaining : [entryRef.current];
			setOpenTabs(next);
			if (activePathRef.current === path)
				selectFile(next[next.length - 1] ?? entryRef.current);
		},
		[openTabs, selectFile],
	);

	const jumpToTest = useCallback(
		(test: TestCase): void => {
			selectFile(test.path.replace(/^src\//, ""));
			setTimeout(() => {
				editorRef.current?.setPosition({
					lineNumber: test.line,
					column: test.column,
				});
				editorRef.current?.revealLineInCenter(test.line);
				editorRef.current?.focus();
			}, 0);
		},
		[selectFile],
	);

	const renameFile = useCallback((path: string): void => {
		if (!session || ENTRY_FILES.has(path)) return;
		const newPath = window.prompt("Nueva ruta relativa a src/:", path)?.trim();
		if (!newPath || newPath === path) return;
		const current = filesRef.current.find((file) => file.path === path);
		if (!current) return;
		const base = session.documentUri.slice(
			0,
			session.documentUri.lastIndexOf("/") + 1,
		);
		const renamed = {
			...current,
			path: newPath,
			uri: new URL(newPath, base).href,
		};
		filesRef.current = filesRef.current.map((file) =>
			file.path === path ? renamed : file,
		);
		setFiles(filesRef.current);
		setOpenTabs((previous) =>
			previous.map((tab) => (tab === path ? newPath : tab)),
		);
		if (activePathRef.current === path) {
			activePathRef.current = newPath;
			setActivePath(newPath);
		}
		const oldLanguage = languageForPath(path);
		if (oldLanguage) lspClientsRef.current[oldLanguage]?.close(current.uri);
		const version = ++versionRef.current;
		sendRuntime({
			type: "file.rename",
			sessionId: session.sessionId,
			version,
			path,
			newPath,
		});
	}, [sendRuntime, session]);

	const deleteFile = useCallback((path: string): void => {
		if (!session || ENTRY_FILES.has(path)) return;
		if (!window.confirm(`¿Eliminar src/${path}?`)) return;
		const current = filesRef.current.find((file) => file.path === path);
		if (!current) return;
		filesRef.current = filesRef.current.filter((file) => file.path !== path);
		setFiles(filesRef.current);
		setOpenTabs((previous) => previous.filter((tab) => tab !== path));
		if (activePathRef.current === path) {
			activePathRef.current = entryRef.current;
			setActivePath(entryRef.current);
		}
		const language = languageForPath(path);
		if (language) lspClientsRef.current[language]?.close(current.uri);
		monacoRef.current?.editor
			.getModel(monacoRef.current.Uri.parse(current.uri))
			?.dispose();
		const version = ++versionRef.current;
		sendRuntime({
			type: "file.delete",
			sessionId: session.sessionId,
			version,
			path,
		});
	}, [sendRuntime, session]);

	const activeFile = files.find((file) => file.path === activePath) ?? files[0];
	useEffect(() => {
		if (!activeFile || !languageForPath(activeFile.path)) return;
		const timer = setTimeout(() => {
			const monaco = monacoRef.current;
			if (!monaco) return;
			const model = monaco.editor.getModel(monaco.Uri.parse(activeFile.uri));
			if (model) openInLsp(activeFile.path, model);
		}, 0);
		return () => clearTimeout(timer);
	}, [activeFile, openInLsp]);
	const visibleSource =
		activeFile?.source ??
		session?.initialSource ??
		localStorage.getItem(SOURCE_KEY) ??
		"";
	const activeLanguageId = languageForPath(activePath);
	const editorLanguage = activeLanguageId
		? /\.(js|mjs|cjs)$/.test(activePath)
			? "javascript"
			: WEB_LANGUAGE_PACKS[activeLanguageId].monacoId
		: activePath.endsWith(".json")
			? "json"
			: activePath.endsWith(".md")
				? "markdown"
				: activePath.endsWith(".h")
					? "c"
					: activePath.endsWith(".hpp")
						? "cpp"
						: "plaintext";
	const onChange = useCallback(
		(source: string | undefined): void => {
			if (!session || source === undefined) return;
			const path = activePathRef.current;
			const current = filesRef.current.find((file) => file.path === path);
			if (!current || source === current.source) return;
			const nextFiles = filesRef.current.map((file) =>
				file.path === path ? { ...file, source } : file,
			);
			filesRef.current = nextFiles;
			setFiles(nextFiles);
			pinnedLogLocationRef.current = undefined;
			logSourceDecorationsRef.current?.clear();
			if (path === entryRef.current) localStorage.setItem(SOURCE_KEY, source);
			const version = ++versionRef.current;
			setStale(true);
			const model = editorRef.current?.getModel();
			const language = languageForPath(path);
			if (model && language)
				lspClientsRef.current[language]?.change(model, version, source);
			if (language && settingsRef.current.autoRun)
				lastRunLanguageRef.current = language;
			sendRuntime({
				type: "document.update",
				sessionId: session.sessionId,
				version,
				path,
				source,
			});
		},
		[sendRuntime, session],
	);

	if (startupError)
		return (
			<main className="startup">
				<h1>ZigLive</h1>
				<h2>Environment error</h2>
				<pre>{startupError}</pre>
				<p>
					Run <code>pnpm run doctor</code>, correct the reported dependency, and
					reload.
				</p>
			</main>
		);
	if (!session)
		return (
			<main className="startup">
				<h1>ZigLive</h1>
				<p>Running environment doctor…</p>
			</main>
		);
	const busy = [
		"debouncing",
		"instrumenting",
		"compiling",
		"running",
		"testing",
	].includes(runState);
	const active = ["instrumenting", "compiling", "running", "testing"].includes(
		runState,
	);
	const zen = layout.zen;
	const dockEffective = narrow ? "bottom" : layout.dock;
	const treeVisible = !zen && layout.treeOpen && !tight;
	const termVisible = !zen && layout.termOpen;
	const failingStatuses = new Set(["failed", "leaked", "timed_out"]);
	const failsByFile = new Map<string, number>();
	for (const test of tests) {
		const testResult = testResults.get(test.testId);
		if (testResult && failingStatuses.has(testResult.status))
			failsByFile.set(test.path, (failsByFile.get(test.path) ?? 0) + 1);
	}
	const failingCount = [...failsByFile.values()].reduce(
		(total, count) => total + count,
		0,
	);
	const treeRows = buildTreeRows({
		files: files.map((file) => file.path),
		collapsed: collapsedFolders,
		pendingFolders,
		failsByFile: new Map(
			[...failsByFile.entries()].map(([path, count]) => [
				path.replace(/^src\//, ""),
				count,
			]),
		),
	});
	const activeTests = tests.filter(
		(test) => test.path === `src/${activePath}`,
	);
	const problemErrors = allProblems.filter(
		(problem) => problem.severity === "error",
	).length;
	const outputRows = groupOutput(output as TerminalEntry[]);
	const diagLabel = active
		? `${RUN_STATE_LABELS[runState]}…`
		: [
				problemErrors
					? `${problemErrors} ${problemErrors === 1 ? "error" : "errores"}`
					: "",
				failingCount
					? `${failingCount} test${failingCount === 1 ? "" : "s"} fallando`
					: "",
			]
				.filter(Boolean)
				.join(" · ") || "sin errores";
	const diagOk = !active && !problemErrors && !failingCount;
	const stageLabel =
		runState === "instrumenting"
			? "instrumentando…"
			: runState === "compiling"
				? `compilando ${activePath}…`
				: runState === "testing"
					? "ejecutando tests…"
					: "ejecutando…";
	const zenStatus = active
		? "ejecutando…"
		: result === undefined
			? RUN_STATE_LABELS[runState]
			: testSummary
				? failingCount
					? `${failingCount} test${failingCount === 1 ? "" : "s"} fallando`
					: `${testSummary.passed}/${tests.length} tests ok · ${result.executionMs.toFixed(1)}ms`
				: result.exitCode === 0
					? `✓ ok · ${result.executionMs.toFixed(1)}ms`
					: "✗ error";
	const testsDone = !busy && testSummary !== undefined;
	const testsTone =
		!testsDone || !tests.length ? "" : failingCount ? "err" : "ok";
	const termTone = active
		? "busy"
		: result === undefined
			? ""
			: result.exitCode === 0 && !failingCount
				? "ok"
				: "err";
	// Design semantics: non-failing over total (skips count toward the left).
	const drawerScore = tests.length
		? `${testsDone ? tests.length - failingCount : "—"}/${tests.length}`
		: "0";
	const drawerSub = !tests.length
		? "esta ejecución no tiene tests"
		: !testsDone
			? busy
				? "corriendo…"
				: "sin ejecutar"
			: failingCount
				? `${failingCount} fallando${result ? ` · ${result.executionMs.toFixed(1)}ms` : ""}`
				: `todos pasando${result ? ` · ${result.executionMs.toFixed(1)}ms` : ""}`;
	const TEST_HINTS: Record<Language, [string, string]> = {
		zig: [
			'salen de los bloques test "…" del archivo',
			'escribe test "nombre" { … } y aparecerá aquí',
		],
		rust: [
			"salen de las fn con #[test] del archivo",
			"escribe #[test] fn nombre() { … } y aparecerá aquí",
		],
		go: [
			"salen de las func TestXxx de *_test.go",
			"escribe func TestNombre(t *testing.T) { … } en un *_test.go",
		],
		ts: [
			"salen de los test()/it() de *.test.ts",
			"escribe test('nombre', () => { … }) en un *.test.ts",
		],
		py: [
			"salen de las def test_* de test_*.py",
			"escribe def test_nombre(): … en un test_*.py",
		],
		c: [
			"salen de las void test_*(void) de *_test.c",
			"escribe void test_nombre(void) { … } en un *_test.c",
		],
		cpp: [
			"salen de las void test_*() de *_test.cpp",
			"escribe void test_nombre() { … } en un *_test.cpp",
		],
	};
	const caseBarTone = (testId: string): string => {
		if (!testsDone) return "";
		const testResult = testResults.get(testId);
		if (!testResult) return "";
		return failingStatuses.has(testResult.status) ? "err" : "ok";
	};
	const zenTone = active
		? "busy"
		: result === undefined
			? "idle"
			: result.exitCode === 0 && !failingCount
				? "ok"
				: "err";
	const activeLanguage =
		languageForPath(activePath) ?? activeLanguageRef.current;
	const runDisabled = Boolean(session.degraded[activeLanguage]);
	const [casesHintSource, casesHintEmpty] = TEST_HINTS[activeLanguage];
	const runCommand = WEB_LANGUAGE_PACKS[activeLanguage].runCommand;
	const testCommand = WEB_LANGUAGE_PACKS[activeLanguage].testCommand;
	const toggleAutoRun = (): void =>
		sendSettings({ ...settings, autoRun: !settings.autoRun });

	const renderEntry = (
		entry: (typeof output)[number],
		index: number,
		child = false,
	): React.JSX.Element => (
		<div
			className={`output-entry${entry.sourceLocation ? " has-source" : ""}${child ? " fold-child" : ""}`}
			key={index}
			onClick={() => {
				if (!entry.sourceLocation) return;
				const path = (entry.sourceLocation.path ?? `src/${entryRef.current}`).replace(
					/^src\//,
					"",
				);
				selectFile(path);
				pinnedLogLocationRef.current = entry.sourceLocation;
				setTimeout(() => highlightLogSource(entry.sourceLocation, true), 0);
			}}
			onKeyDown={(event) => {
				if (
					entry.sourceLocation &&
					(event.key === "Enter" || event.key === " ")
				) {
					event.preventDefault();
					const path = (entry.sourceLocation.path ?? `src/${entryRef.current}`).replace(
						/^src\//,
						"",
					);
					selectFile(path);
					pinnedLogLocationRef.current = entry.sourceLocation;
					setTimeout(() => highlightLogSource(entry.sourceLocation, true), 0);
				}
			}}
			onMouseEnter={() => highlightLogSource(entry.sourceLocation)}
			onMouseLeave={() => highlightLogSource(pinnedLogLocationRef.current)}
			role={entry.sourceLocation ? "button" : undefined}
			tabIndex={entry.sourceLocation ? 0 : undefined}
			title={
				entry.sourceLocation
					? `Generado por ${entry.sourceLocation.path ?? `src/${entryRef.current}`}:${entry.sourceLocation.line}:${entry.sourceLocation.column} · ejecución #${entry.sourceLocation.executionIndex}`
					: undefined
			}
		>
			<span className="output-chevron">›</span>
			<pre className={entry.category}>{entry.chunk}</pre>
			<time>
				{(
					(entry.receivedAt - (output[0]?.receivedAt ?? entry.receivedAt)) /
					1000
				).toFixed(3)}
				s
			</time>
			{entry.sourceLocation && (
				<span className="log-origin-tooltip">
					↳ {entry.sourceLocation.path ?? `src/${entryRef.current}`}:
					{entry.sourceLocation.line}:{entry.sourceLocation.column} · ejecución
					#{entry.sourceLocation.executionIndex}
					{entry.sourceLocation.loop && (
						<>
							{" "}
							· bucle {entry.sourceLocation.loop.line}:
							{entry.sourceLocation.loop.column} ·{" "}
							<b>
								{entry.sourceLocation.loop.variable}=
								{entry.sourceLocation.loop.value}
							</b>
						</>
					)}
				</span>
			)}
		</div>
	);

	return (
		<main
			className={`app-shell${zen ? " zen" : ""} dock-${dockEffective}${layout.termMax ? " term-max" : ""}`}
			data-theme={appearance.theme}
			style={{ fontFamily: APP_FONTS[appearance.fontIndex]?.css }}
		>
			<div className="workspace">
				{treeVisible && (
					<aside className="tree-card">
						<div
							className="file-tree"
							onContextMenu={(event) => {
								event.preventDefault();
								const row =
									event.target instanceof Element
										? event.target.closest<HTMLElement>(
												"[data-tree-path], [data-tree-folder]",
											)
										: null;
								setTreeContextMenu({
									x: event.clientX,
									y: event.clientY,
									...(row?.dataset.treePath
										? { path: row.dataset.treePath }
										: {}),
									...(row?.dataset.treeFolder
										? { folder: row.dataset.treeFolder }
										: {}),
								});
							}}
						>
							<div className="tree-root">
								<span className="chev">
									<Lucide icon="chevron-down" size={13} />
								</span>
								<FolderIcon open /> src
								<span className="tree-menu-wrap root-tools">
									<button
										aria-label="Acciones del árbol"
										className={`tree-menu-btn${treeMenuOpen ? " open" : ""}`}
										onClick={() => setTreeMenuOpen((previous) => !previous)}
									>
										<Lucide icon="ellipsis-vertical" size={14} />
									</button>
								</span>
							</div>
							{treeMenuOpen && (
								<div className="term-menu tree-menu" role="menu">
									<button
										onClick={() => {
											setTreeMenuOpen(false);
											createFile();
										}}
										role="menuitem"
									>
										<Lucide icon="file-plus" size={13} />
										<span>Crear archivo</span>
									</button>
									<button
										onClick={() => {
											setTreeMenuOpen(false);
											createFolder();
										}}
										role="menuitem"
									>
										<Lucide icon="folder-plus" size={13} />
										<span>Crear carpeta</span>
									</button>
									<span className="term-menu-sep" />
									<button
										disabled={ENTRY_FILES.has(activePath)}
										onClick={() => {
											setTreeMenuOpen(false);
											renameFile(activePathRef.current);
										}}
										role="menuitem"
									>
										<Lucide icon="pencil" size={13} />
										<span>Renombrar archivo</span>
									</button>
									<button
										disabled={ENTRY_FILES.has(activePath)}
										onClick={() => {
											setTreeMenuOpen(false);
											deleteFile(activePathRef.current);
										}}
										role="menuitem"
									>
										<Lucide icon="trash-2" size={13} />
										<span>Eliminar archivo</span>
									</button>
									<span className="term-menu-sep" />
									<button
										onClick={() => {
											setTreeMenuOpen(false);
											updateLayout({ treeOpen: false });
										}}
										role="menuitem"
									>
										<Lucide icon="panel-left-close" size={13} />
										<span>Ocultar árbol</span>
										<b>⌘B</b>
									</button>
								</div>
							)}
							{treeRows.map((row) => {
								if (row.kind === "folder")
									return (
										<div
											className="tree-folder-row"
											data-tree-folder={row.path}
											key={`folder:${row.path}`}
											style={{ paddingLeft: `${10 + row.depth * 14}px` }}
										>
											<button
												className="tree-folder"
												onClick={() => toggleFolder(row.path)}
												title={row.path}
											>
												<span className="chev">
													{row.collapsed ? "▸" : "▾"}
												</span>
												<FolderIcon open={!row.collapsed} />
												<span className="folder-name">{row.name}</span>
												{row.fails > 0 && (
													<span className="tree-badge fails">
														{row.fails}
													</span>
												)}
											</button>
											<button
												className="folder-add"
												onClick={() => createFile(`${row.path}/`)}
												title={`Crear archivo en ${row.path}/`}
											>
												＋
											</button>
										</div>
									);
								const fails = failsByFile.get(`src/${row.path}`) ?? 0;
								return (
									<button
										aria-label={row.path}
										className={`tree-file${row.path === activePath ? " active" : ""}`}
										data-tree-path={row.path}
										key={row.path}
										onClick={() => selectFile(row.path)}
										style={{ paddingLeft: `${22 + row.depth * 14}px` }}
										title={row.path}
									>
										<FileIcon path={row.path} /> {row.name}
										<span className={`tree-badge${fails ? " fails" : ""}`}>
											{fails
												? String(fails)
												: row.path === activePath
													? "✓"
													: ""}
										</span>
									</button>
								);
							})}
						</div>
					</aside>
				)}

				<div className="inner">
					<section className="editor-card">
						{!zen && (
							<div className="editor-chrome">
								{!treeVisible && !tight && (
									<button
										className="tree-restore"
										onClick={() => updateLayout({ treeOpen: true })}
										title="Mostrar árbol (⌘B)"
									>
										<Lucide icon="panel-left" size={14} />
									</button>
								)}
								<div className="tab-pill" role="tablist">
									{openTabs.map((path) => {
										return (
											<div
												className={`buffer-tab${path === activePath ? " active" : ""}`}
												key={path}
												onClick={() => selectFile(path)}
												onKeyDown={(event) => {
													if (event.key === "Enter") selectFile(path);
												}}
												role="tab"
												aria-selected={path === activePath}
												tabIndex={0}
											>
												<FileIcon path={path} />
												<span>{path}</span>
												{stale && path === activePath && (
													<em className="stale-dot" />
												)}
												<span
													className="tab-close"
													onClick={(event) => {
														event.stopPropagation();
														closeTab(path);
													}}
													role="button"
													tabIndex={-1}
													title="Cerrar tab"
												>
													✕
												</span>
											</div>
										);
									})}
									<button
										className="tab-add"
										onClick={() => setPaletteOpen(true)}
										title="Buscar archivo (⌘K)"
									>
										+
									</button>
								</div>
								<div className="chrome-right">
									<button
										className={`auto-text${settings.autoRun ? " on" : ""}`}
										disabled={runDisabled}
										onClick={toggleAutoRun}
										title={
											settings.autoRun
												? "Auto Run activo — clic para pausar"
												: "Auto Run pausado — clic para activar"
										}
									>
										auto
									</button>
									<button
										className="chrome-icon"
										onClick={() => setSettingsOpen(true)}
										title="Ajustes (⌘,)"
									>
										<Lucide icon="settings" size={14} />
									</button>
									<button
										aria-label={active ? "Detener" : "Run"}
										className={`run-button${active ? " running" : ""}`}
										disabled={runDisabled}
										onClick={active ? stop : run}
										title={active ? "Detener" : "Run (⌘↵)"}
									>
										{active ? (
											<span className="spin">⟳</span>
										) : (
											<Lucide icon="play" size={13} />
										)}
									</button>
								</div>
							</div>
						)}
						<div className="editor-wrap">
							<Editor
								height="100%"
								path={activeFile?.uri ?? session.documentUri}
								language={editorLanguage}
								value={visibleSource}
								theme={zen ? "ziglive-zen" : "ziglive-dark"}
								beforeMount={registerAllLanguages}
								onMount={handleMount}
								onChange={onChange}
								options={{
									automaticLayout: true,
									fontFamily:
										APP_FONTS[appearance.fontIndex]?.css ??
										'"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
									fontLigatures: true,
									fontSize: APP_SIZES[appearance.sizeIndex] ?? 13,
									glyphMargin: true,
									inlineSuggest: { enabled: true },
									lineHeight: (APP_SIZES[appearance.sizeIndex] ?? 13) + 11,
									suggestFontSize: APP_SIZES[appearance.sizeIndex] ?? 13,
									suggestLineHeight:
										(APP_SIZES[appearance.sizeIndex] ?? 13) + 11,
									minimap: { enabled: false },
									overviewRulerBorder: false,
									padding: { top: 14 },
									renderLineHighlight: "none",
									scrollBeyondLastLine: false,
								}}
							/>
						</div>
					</section>

					{termVisible && (
						<section className="side-panel">
							<header className="pane-header terminal-header">
								<span className={`run-dot ${termTone}`} />
								{tab !== "output" && (
									<span className="term-view-label">
										{tab === "problems"
											? `Problemas${allProblems.length ? ` ${allProblems.length}` : ""}`
											: "Runtime"}
									</span>
								)}
								<span className="term-menu-wrap">
									<button
										aria-label="Opciones del terminal"
										className={`term-menu-btn${termMenuOpen ? " open" : ""}`}
										onClick={() => setTermMenuOpen((previous) => !previous)}
									>
										<Lucide icon="ellipsis-vertical" size={15} />
									</button>
									{termMenuOpen && (
										<div className="term-menu" role="menu">
											{!narrow && (
												<>
													<button
														className={
															dockEffective === "right" && !layout.termMax
																? "on"
																: ""
														}
														onClick={() => {
															updateLayout({ dock: "right", termMax: false });
															setTermMenuOpen(false);
														}}
														role="menuitem"
													>
														<Lucide icon="panel-right" size={13} />
														<span>Acoplar a la derecha</span>
													</button>
													<button
														className={
															dockEffective === "bottom" && !layout.termMax
																? "on"
																: ""
														}
														onClick={() => {
															updateLayout({ dock: "bottom", termMax: false });
															setTermMenuOpen(false);
														}}
														role="menuitem"
													>
														<Lucide icon="panel-bottom" size={13} />
														<span>Acoplar abajo</span>
													</button>
												</>
											)}
											<button
												className={layout.termMax ? "on" : ""}
												onClick={() => {
													updateLayout({ termMax: !layout.termMax });
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide
													icon={layout.termMax ? "minimize-2" : "maximize-2"}
													size={13}
												/>
												<span>
													{layout.termMax ? "Restaurar tamaño" : "Maximizar"}
												</span>
											</button>
											<button
												className={drawer ? "on" : ""}
												onClick={() => {
													setDrawer((previous) => !previous);
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide icon="flask-conical" size={13} />
												<span>{drawer ? "Ocultar tests" : "Ver tests"}</span>
												<b>⌘T</b>
											</button>
											<span className="term-menu-sep" />
											<button
												className={tab === "output" ? "on" : ""}
												onClick={() => {
													setTab("output");
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide icon="terminal" size={13} />
												<span>Salida</span>
											</button>
											<button
												aria-label={`Problems (${allProblems.length})`}
												className={tab === "problems" ? "on" : ""}
												onClick={() => {
													setTab("problems");
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide icon="triangle-alert" size={13} />
												<span>
													Problemas
													{allProblems.length ? ` ${allProblems.length}` : ""}
												</span>
											</button>
											<button
												className={tab === "runtime" ? "on" : ""}
												onClick={() => {
													setTab("runtime");
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide icon="activity" size={13} />
												<span>Runtime</span>
											</button>
											<span className="term-menu-sep" />
											<button
												onClick={() => {
													setOutput([]);
													pinnedLogLocationRef.current = undefined;
													logSourceDecorationsRef.current?.clear();
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide icon="eraser" size={13} />
												<span>Limpiar salida</span>
											</button>
											<button
												onClick={() => {
													updateLayout({ termOpen: false });
													setTermMenuOpen(false);
												}}
												role="menuitem"
											>
												<Lucide icon="x" size={13} />
												<span>Cerrar terminal</span>
												<b>⌘J</b>
											</button>
										</div>
									)}
								</span>
							</header>

							<div className="panel-content">
								{tab === "output" && (
									<div className={`output-list${drawer ? " dimmed" : ""}`}>
										<div className="terminal-command">
											<b>$</b> {runCommand}
											{tests.length ? ` · ${testCommand} (${tests.length})` : ""}
										</div>
										{outputRows.map((row) =>
											row.kind === "line" ? (
												renderEntry(row.entry, row.index)
											) : (
												<div className="fold-group" key={row.key}>
													<button
														className="fold-row"
														onClick={() =>
															setOpenFolds((previous) => {
																const next = new Set(previous);
																if (next.has(row.key)) next.delete(row.key);
																else next.add(row.key);
																return next;
															})
														}
													>
														<span>
															{openFolds.has(row.key) ? "▾" : "▸"} {row.label}{" "}
															({row.entries.length} líneas)
														</span>
														<b>{openFolds.has(row.key) ? "ocultar" : "ver"}</b>
													</button>
													{openFolds.has(row.key) &&
														row.entries.map((grouped) =>
															renderEntry(grouped.entry, grouped.index, true),
														)}
												</div>
											),
										)}
										{!output.length && !busy && (
											<p className="empty-state">La salida aparecerá aquí.</p>
										)}
										{active && (
											<div className="run-stage">
												<span className="spin">⟳</span> {stageLabel}
											</div>
										)}



									</div>
								)}
								{tab === "problems" && (
									<ul className="problems-list">
										{allProblems.length ? (
											allProblems.map((item, index) => (
												<li
													className={`problem problem-${item.severity}`}
													key={`${item.owner}-${index}`}
												>
													<button
														onClick={() => {
															selectFile(
																(item.path ?? `src/${entryRef.current}`).replace(
																	/^src\//,
																	"",
																),
															);
															setTimeout(() => {
																editorRef.current?.setPosition({
																	lineNumber: item.line,
																	column: item.column,
																});
																editorRef.current?.revealLineInCenter(
																	item.line,
																);
																editorRef.current?.focus();
															}, 0);
														}}
													>
														<i>{item.severity === "error" ? "×" : "△"}</i>
														<span>{item.message}</span>
														<small>
															{item.path ?? `src/${entryRef.current}`} · {item.owner} · Ln{" "}
															{item.line}, Col {item.column}
														</small>
													</button>
												</li>
											))
										) : (
											<li className="empty-state">No diagnostics.</li>
										)}
									</ul>
								)}
								{tab === "runtime" && (
									<div className="runtime-grid">
										<span>Estado</span>
										<b>{RUN_STATE_LABELS[runState]}</b>
										<span>Código de salida</span>
										<b>{result?.exitCode ?? "—"}</b>
										<span>Señal</span>
										<b>{result?.signal ?? "—"}</b>
										<span>Timeout</span>
										<b>{result?.timedOut ? "sí" : "no"}</b>
										<span>Probes / valores</span>
										<b>
											{catalog.length} / {values.size}
										</b>
										<span>Tests</span>
										<b>
											{testSummary
												? `${testSummary.passed} ok · ${testSummary.failed} err · ${testSummary.skipped} skip${testSummary.leaked ? ` · ${testSummary.leaked} leak` : ""}`
												: tests.length
													? `${tests.length} detectados`
													: "—"}
										</b>
										<span>Toolchain</span>
										<b>
											{session.toolchains?.[activeLanguage]?.run ??
												session.zigVersion}
										</b>
										<span>LSP</span>
										<b className="capabilities">
											{Object.keys(capabilities[activeLanguage] ?? {})
												.filter((key) => capabilities[activeLanguage]?.[key])
												.join(", ") || status}
										</b>
									</div>
								)}
							</div>

							{tab === "output" && !drawer && (
								<button
									className="test-bar"
									onClick={() => setDrawer(true)}
									title="Ver tests (⌘T)"
								>
									<Lucide icon="chevron-up" size={13} />
									<span className="test-bar-label">
										<span className={`run-dot ${testsTone}`} />
										Tests
									</span>
									<span className="case-bars">
										{tests.slice(0, 24).map((test) => (
											<span
												className={`case-bar ${caseBarTone(test.testId)}`}
												key={test.testId}
											/>
										))}
									</span>
									<b className={`test-score ${testsTone}`}>{drawerScore}</b>
									<span className="test-bar-kbd">⌘T</span>
								</button>
							)}

							{tab === "output" && drawer && (
								<div className="tests-drawer">
									<button
										className="drawer-handle"
										onClick={() => setDrawer(false)}
										title="Ocultar tests (⌘T)"
									>
										<span />
									</button>
									<div className="drawer-head">
										<b className={`drawer-score ${testsTone}`}>{drawerScore}</b>
										<div className="drawer-sub-wrap">
											<span className="drawer-sub">{drawerSub}</span>
											<span className="case-bars">
												{tests.slice(0, 24).map((test) => (
													<span
														className={`case-bar ${caseBarTone(test.testId)}`}
														key={test.testId}
													/>
												))}
											</span>
										</div>
										<span className="drawer-tabs">
											<button
												className={drawerTab === "tests" ? "active" : ""}
												onClick={() => setDrawerTab("tests")}
											>
												Tests
											</button>
											<button
												className={drawerTab === "hist" ? "active" : ""}
												onClick={() => setDrawerTab("hist")}
											>
												Historial
											</button>
										</span>
										<button
											className="drawer-close"
											onClick={() => setDrawer(false)}
											title="Cerrar (⌘T)"
										>
											<Lucide icon="chevron-down" size={14} />
										</button>
									</div>

									{drawerTab === "hist" ? (
										<div className="drawer-list history-list">
											{history.map((entry) => (
												<div className="history-row" key={entry.n}>
													<Lucide
														icon={entry.ok ? "circle-check" : "circle-x"}
														size={13}
													/>
													<span className={entry.ok ? "ok" : "err"}>
														#{entry.n}
													</span>
													<span className="history-ms">{entry.ms}</span>
												</div>
											))}
											{!history.length && (
												<div className="empty-state">sin corridas todavía</div>
											)}
										</div>
									) : (
										<div className="drawer-list cases-list">
											{tests.map((test) => {
												const testResult = testResults.get(test.testId);
												const failing =
													testResult &&
													failingStatuses.has(testResult.status);
												return (
													<div
														className={`case-item${failing ? " failed" : ""}`}
														key={test.testId}
													>
														<button
															className="case-row"
															onClick={() => jumpToTest(test)}
														>
															<span
																className={`case-mark${
																	testResult
																		? failing
																			? " err"
																			: testResult.status === "passed"
																				? " ok"
																				: ""
																		: ""
																}`}
															>
																<Lucide
																	icon={
																		!testResult
																			? "circle-dashed"
																			: failing
																				? "circle-x"
																				: "circle-check"
																	}
																	size={14}
																/>
															</span>
															<span className="case-text">
																<span className="case-name">{test.name}</span>
																<span className="case-where">
																	{test.path.replace(/^src\//, "")} · L
																	{test.line}
																</span>
															</span>
															<span className="case-meta">
																{testResult && !failing
																	? testResult.status === "passed"
																		? testResult.durationMs < 0.05
																			? "ok"
																			: `${testResult.durationMs.toFixed(1)}ms`
																		: testResult.status
																	: `L${test.line}`}
															</span>
														</button>
														{failing && (
															<div className="case-detail">
																{testResult?.message && (
																	<pre className="case-message">
																		{testResult.message}
																	</pre>
																)}
																<div className="case-actions">
																	<button onClick={() => jumpToTest(test)}>
																		ir a L{test.line}
																	</button>
																	<button onClick={run}>correr tests</button>
																</div>
															</div>
														)}
													</div>
												);
											})}
											{[...testResults.values()]
												.filter((testResult) => !testResult.testId)
												.map((testResult) => (
													<div
														className="case-item unmatched"
														key={testResult.name}
													>
														<span
															className={`case-mark${failingStatuses.has(testResult.status) ? " err" : " ok"}`}
														>
															<Lucide
																icon={
																	failingStatuses.has(testResult.status)
																		? "circle-x"
																		: "circle-check"
																}
																size={14}
															/>
														</span>
														<span className="case-name">
															{testResult.name}
														</span>
													</div>
												))}
											<div className="cases-hint">
												{tests.length
													? `${casesHintSource} · clic para ir a la línea`
													: casesHintEmpty}
											</div>
										</div>
									)}
								</div>
							)}
						</section>
					)}
				</div>
			</div>

			{treeContextMenu && (
				<div
					className="term-menu tree-context-menu"
					ref={(menu) => {
						if (!menu) return;
						const { innerWidth, innerHeight } = window;
						const rect = menu.getBoundingClientRect();
						menu.style.left = `${Math.min(treeContextMenu.x, innerWidth - rect.width - 8)}px`;
						menu.style.top = `${Math.min(treeContextMenu.y, innerHeight - rect.height - 8)}px`;
					}}
					role="menu"
				>
					{treeContextMenu.path && (
						<>
							<button
								onClick={() => {
									setTreeContextMenu(undefined);
									if (treeContextMenu.path) selectFile(treeContextMenu.path);
								}}
								role="menuitem"
							>
								<Lucide icon="chevron-right" size={13} />
								<span>Abrir</span>
							</button>
							<button
								disabled={ENTRY_FILES.has(treeContextMenu.path)}
								onClick={() => {
									setTreeContextMenu(undefined);
									if (treeContextMenu.path)
										renameFile(treeContextMenu.path);
								}}
								role="menuitem"
							>
								<Lucide icon="pencil" size={13} />
								<span>Renombrar</span>
							</button>
							<button
								disabled={ENTRY_FILES.has(treeContextMenu.path)}
								onClick={() => {
									setTreeContextMenu(undefined);
									if (treeContextMenu.path)
										deleteFile(treeContextMenu.path);
								}}
								role="menuitem"
							>
								<Lucide icon="trash-2" size={13} />
								<span>Eliminar</span>
							</button>
							<span className="term-menu-sep" />
						</>
					)}
					<button
						onClick={() => {
							setTreeContextMenu(undefined);
							const base =
								treeContextMenu.folder ??
								(treeContextMenu.path?.includes("/")
									? treeContextMenu.path.slice(
											0,
											treeContextMenu.path.lastIndexOf("/"),
										)
									: undefined);
							createFile(base ? `${base}/` : "");
						}}
						role="menuitem"
					>
						<Lucide icon="file-plus" size={13} />
						<span>
							Nuevo archivo
							{treeContextMenu.folder ? ` en ${treeContextMenu.folder}/` : ""}
						</span>
					</button>
					<button
						onClick={() => {
							setTreeContextMenu(undefined);
							createFolder();
						}}
						role="menuitem"
					>
						<Lucide icon="folder-plus" size={13} />
						<span>Nueva carpeta</span>
					</button>
				</div>
			)}
			{editorContextMenu && (
				<div
					className="editor-context-menu"
					ref={(menu) => {
						if (!menu) return;
						menu.style.left = `${editorContextMenu.x}px`;
						menu.style.top = `${editorContextMenu.y}px`;
					}}
					role="menu"
				>
					<button role="menuitem" onClick={() => void copyFromEditor()}>
						Copy
					</button>
					<button role="menuitem" onClick={() => void pasteIntoEditor()}>
						Paste
					</button>
				</div>
			)}

			<footer className="global-status">
				<span className={`mode-chip mode-${vimModeLabel.toLowerCase()}`}>
					{vimModeLabel}
				</span>
				<div className="vim-mode-slot">
					<div className="vim-status" ref={vimStatusRef} />
				</div>
				<span className="branch-status">
					⎇ main <b>+{values.size}</b>
				</span>
				<span className={`run-state state-${runState}`}>
					{RUN_STATE_LABELS[runState]}
				</span>
				<span className="status-path">src/{activePath}</span>
				{Object.entries(session.degraded).some(([key]) =>
					key.startsWith(activeLanguage),
				) && (
					<span className="degraded">
						{Object.entries(session.degraded)
							.filter(([key]) => key.startsWith(activeLanguage))
							.map(([, message]) => message)
							.join(" · ")}
					</span>
				)}
				<span className="status-spacer" />
				<span className="status-timing">
					{result
						? `run ${result.executionMs.toFixed(0)}ms · compile ${result.compilationMs.toFixed(0)}ms`
						: `${activeLanguage} · utf-8`}
				</span>
				<strong className="cursor-status">
					{cursorPosition.line}:{cursorPosition.column}
				</strong>
			</footer>

			{zen && (
				<div className="zen-pill">
					<span className={`zen-dot ${zenTone}`} />
					<span className="zen-status">{zenStatus}</span>
					<button
						className="zen-run"
						disabled={runDisabled}
						onClick={active ? stop : run}
					>
						<Lucide icon={active ? "square" : "play"} size={12} /> Run
					</button>
					<button className="zen-exit" onClick={toggleZen}>
						salir ⌘.
					</button>
				</div>
			)}

			{peekNode &&
				peek &&
				(() => {
					const peekValue = values.get(peek.probeId);
					const peekModel = editorRef.current?.getModel();
					if (!peekValue || peek.path !== activePath || !peekModel)
						return null;
					const lineText =
						peekValue.line <= peekModel.getLineCount()
							? peekModel.getLineContent(peekValue.line)
							: "";
					// Previous value of the same variable: same-probe history in
					// loops, otherwise the closest earlier probe by sequence.
					let previousValue: bigint | undefined;
					if (peekValue.history.length >= 2)
						previousValue = parseIntegerPreview(
							peekValue.history[peekValue.history.length - 2] ?? "",
						);
					else {
						let best: InlineValue | undefined;
						for (const candidate of values.values())
							if (
								candidate.name === peekValue.name &&
								candidate.probeId !== peekValue.probeId &&
								candidate.sequence < peekValue.sequence &&
								(!best || candidate.sequence > best.sequence)
							)
								best = candidate;
						previousValue = best
							? parseIntegerPreview(best.preview)
							: undefined;
					}
					return createPortal(
						<PeekPanel
							fmt={valueFmt}
							previousValue={previousValue}
							language={activeLanguage}
							lineText={lineText}
							onClose={() => setPeek(null)}
							onFlip={setPeekOverride}
							onReset={() => setPeekOverride(undefined)}
							override={peekOverride}
							value={peekValue}
						/>,
						peekNode,
					);
				})()}
			{settingsOpen && (
				<SettingsModal
					fontIndex={appearance.fontIndex}
					onClose={() => setSettingsOpen(false)}
					onFont={(index) => updateAppearance({ fontIndex: index })}
					onSize={(index) => updateAppearance({ sizeIndex: index })}
					onTheme={(theme) => updateAppearance({ theme })}
					onValueFmt={(fmt) => {
						setValueFmt(fmt);
						localStorage.setItem(VALUE_FMT_KEY, fmt);
					}}
					sizeIndex={appearance.sizeIndex}
					theme={appearance.theme}
					toggles={[
						{
							label: "Auto Run",
							hint: "ejecuta al dejar de escribir",
							on: settings.autoRun,
							disabled: runDisabled,
							act: toggleAutoRun,
						},
						{
							label: "Auto Inspect",
							hint: "valores en línea",
							on: settings.autoInspect,
							act: () => {
								sendSettings({
									...settings,
									autoInspect: !settings.autoInspect,
								});
								setTimeout(run, 0);
							},
						},
						{
							label: "Vim Mode",
							hint: "",
							on: vimEnabled,
							act: () => changeVimMode(!vimEnabled),
						},
						{
							label: "Zen Mode",
							hint: "⌘.",
							on: zen,
							act: () => {
								setSettingsOpen(false);
								toggleZen();
							},
						},
					]}
					valueFmt={valueFmt}
				/>
			)}
			{paletteOpen && (
				<CommandPalette
					activePath={activePath}
					files={files}
					onClose={() => setPaletteOpen(false)}
					onCreate={(path) => {
						createFileNamed(path);
						setPaletteOpen(false);
					}}
					onOpen={(path, runNow) => {
						selectFile(path);
						setPaletteOpen(false);
						if (runNow) setTimeout(run, 0);
					}}
				/>
			)}
		</main>
	);
}
