import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type {
	CreateSessionResponse,
	Language,
	ProbeDescriptor,
} from "@atomis/protocol";
import type * as MonacoApi from "monaco-editor";
import {
	initVimMode,
	StatusBar as VimStatusBar,
	VimMode,
	type VimAdapterInstance,
} from "monaco-vim";
import { CommandPalette } from "./components/CommandPalette.js";
import { DepsPanel } from "./components/DepsPanel.js";
import {
	EditorContextMenu,
	TreeContextMenu,
} from "./components/ContextMenus.js";
import { EditorChrome } from "./components/EditorChrome.js";
import { FileTree } from "./components/FileTree.js";
import { PeekPanel } from "./components/PeekPanel.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { StatusBar, ZenPill } from "./components/StatusBar.js";
import { Terminal, type TerminalTab } from "./components/Terminal.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { TestsDrawer } from "./components/TestsDrawer.js";
import {
	installVimExtensions,
	updateVimAppCommands,
} from "./editor/vimExtensions.js";
import { useDismissable } from "./hooks/useDismissable.js";
import { useEditorDecorations } from "./hooks/useEditorDecorations.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useKeyboardNav, type TreeNavRow } from "./hooks/useKeyboardNav.js";
import { useMediaLayout } from "./hooks/useMediaLayout.js";
import { usePeekPanel } from "./hooks/usePeekPanel.js";
import { useQuickScope } from "./hooks/useQuickScope.js";
import { useProjectFiles } from "./hooks/useProjectFiles.js";
import { useRuntimeEvents } from "./hooks/useRuntimeEvents.js";
import {
	ENTRY_FILES,
	languageForPath,
	monacoLanguageFor,
	registerAllLanguages,
	WEB_LANGUAGE_PACKS,
} from "./languages.js";
import {
	parseIntegerPreview,
	VALUE_FMTS,
	type ValueFmt,
} from "./lowlevel.js";
import { LspClient } from "./lsp/LspClient.js";
import { lspSeverityName, type JsonValue } from "./lsp/protocol.js";
import {
	APPEARANCE_KEY,
	APP_FONTS,
	APP_SIZES,
	loadAppearance,
	saveAppearance,
	type Appearance,
} from "./state/appearance.js";
import { flattenProblems, type OwnedDiagnostic } from "./state/diagnostics.js";
import { buildTreeRows } from "./state/fileTree.js";
import { websocketUrl } from "./state/paths.js";
import {
	caseTone,
	computeFailsByFile,
	drawerScoreLabel,
	drawerSubLabel,
	isActive,
	isBusy,
	RUN_STATE_LABELS,
	stageLabel,
	TEST_HINTS,
	termTone,
	testsTone,
	totalFails,
	zenStatusLabel,
	zenTone,
} from "./state/runSummary.js";
import { toggleProbe, type InlineValue } from "./state/runtimeState.js";
import {
	CHROME_KEY,
	loadChrome,
	saveChrome,
	tabsVisible,
	type ChromeSettings,
} from "./state/chrome.js";
import { subscribeToPreferences } from "./state/storage.js";
import {
	INLINE_LOGS_KEY,
	SETTINGS_KEY,
	VALUE_FMT_KEY,
	VIM_MODE_KEY,
	loadEntrySource,
	loadInlineLogs,
	loadLanguage,
	loadLayout,
	loadScaffold,
	loadSettings,
	loadValueFmt,
	loadVimMode,
	saveEntrySource,
	saveInlineLogs,
	saveLayout,
	saveScaffold,
	saveSettings,
	saveValueFmt,
	saveVimMode,
	type LayoutState,
	type Settings,
} from "./state/settings.js";
import { groupOutput } from "./state/terminalFolds.js";
import {
	createWorkspace,
	deleteWorkspace,
	listWorkspaces,
	loadActiveWorkspace,
	renameWorkspace,
	saveActiveWorkspace,
} from "./state/workspaces.js";
import type { WorkspaceMeta } from "@atomis/protocol";
import type { LogSourceLocation, ProjectFile } from "./types.js";

interface VimModeWithCommands {
	Vim: {
		defineEx: (name: string, prefix: string, callback: () => void) => void;
		unmap: (keys: string, context?: "normal" | "insert" | "visual") => boolean;
		exitInsertMode: (adapter: object) => void;
		exitVisualMode: (adapter: object) => void;
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

export function App(): React.JSX.Element {
	const entryRef = useRef("main.zig");
	const [session, setSession] = useState<CreateSessionResponse>();
	const [files, setFiles] = useState<ProjectFile[]>([]);
	const [startupError, setStartupError] = useState<string>();
	const [settings, setSettings] = useState<Settings>(loadSettings);
	const [valueFmt, setValueFmt] = useState<ValueFmt>(loadValueFmt);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
	const appearanceRef = useRef(appearance);
	appearanceRef.current = appearance;
	const [status, setStatus] = useState("Starting…");
	const [tab, setTab] = useState<TerminalTab>("output");
	const [drawerTab, setDrawerTab] = useState<"tests" | "hist">("tests");
	const [capabilities, setCapabilities] = useState<
		Partial<Record<Language, Record<string, JsonValue>>>
	>({});
	const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
	const [vimEnabled, setVimEnabled] = useState(loadVimMode);
	const [inlineLogs, setInlineLogs] = useState(loadInlineLogs);
	const [editorContextMenu, setEditorContextMenu] = useState<{
		x: number;
		y: number;
	}>();
	const [layout, setLayout] = useState<LayoutState>(loadLayout);
	const [chrome, setChrome] = useState<ChromeSettings>(loadChrome);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
	const [workspaceBusy, setWorkspaceBusy] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [workspaceError, setWorkspaceError] = useState<string>();
	const [vimModeLabel, setVimModeLabel] = useState("NORMAL");

	// Settings changed on another device arrive over the runtime socket and
	// land in the shared store; re-read through the same loaders so what
	// validates a stored value is the same code either way. Only the keys
	// that actually moved are reported, so this never re-renders on our own
	// change — which matters because `settings` gates the auto-run effect.
	useEffect(
		() =>
			subscribeToPreferences((changed) => {
				if (changed.has(SETTINGS_KEY)) setSettings(loadSettings());
				if (changed.has(VALUE_FMT_KEY)) setValueFmt(loadValueFmt());
				if (changed.has(APPEARANCE_KEY)) setAppearance(loadAppearance());
				if (changed.has(VIM_MODE_KEY)) setVimEnabled(loadVimMode());
				if (changed.has(INLINE_LOGS_KEY)) setInlineLogs(loadInlineLogs());
				if (changed.has(CHROME_KEY)) setChrome(loadChrome());
			}),
		[],
	);

	const vimModeRef = useRef("NORMAL");
	vimModeRef.current = vimModeLabel;
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
	const testLensDecorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const testLensWidgetsRef = useRef<MonacoApi.editor.IContentWidget[]>([]);
	const inlineLogDecorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const versionRef = useRef(1);
	const filesRef = useRef<ProjectFile[]>([]);
	const lastRunLanguageRef = useRef<Language | null>(null);
	const settingsRef = useRef(settings);
	const treeNavRef = useRef<TreeNavRow[]>([]);
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const paletteOpenRef = useRef(paletteOpen);
	paletteOpenRef.current = paletteOpen;

	const { narrow, tight } = useMediaLayout();

	const runtime = useRuntimeEvents({
		versionRef,
		filesRef,
		setFiles,
		monacoRef,
		entryRef,
		pinnedLogLocationRef,
		logSourceDecorationsRef,
		setStatus,
	});
	const {
		reset: resetRuntime,
		runState,
		catalog,
		catalogRef,
		values,
		valuesRef,
		stale,
		setStale,
		output,
		setOutput,
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
	} = runtime;

	const allProblems = useMemo<OwnedDiagnostic[]>(
		() => flattenProblems(runtime.diagnostics),
		[runtime.diagnostics],
	);

	const sendRuntime = useCallback((message: object): void => {
		if (runtimeRef.current?.readyState === WebSocket.OPEN)
			runtimeRef.current.send(JSON.stringify(message));
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
							severity: lspSeverityName(item.severity),
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
		[setDiagnostics],
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

	const project = useProjectFiles({
		session,
		sendRuntime,
		versionRef,
		entryRef,
		activeLanguageRef,
		filesRef,
		setFiles,
		lspClientsRef,
		monacoRef,
		openInLsp,
		pinnedLogLocationRef,
		logSourceDecorationsRef,
		setStatus,
	});
	const {
		activePath,
		activePathRef,
		openTabs,
		openTabsRef,
		selectFile,
		toggleFolder,
		resetToEntry,
		closeOtherTabs,
		setSrcCollapsed,
		setTreeContextMenu,
	} = project;

	const updateLayout = useCallback((patch: Partial<LayoutState>): void => {
		setLayout((previous) => {
			const next = { ...previous, ...patch };
			saveLayout(next);
			return next;
		});
	}, []);
	const toggleZen = useCallback(
		() => updateLayout({ zen: !layoutRef.current.zen }),
		[updateLayout],
	);
	const updateChrome = useCallback((patch: Partial<ChromeSettings>): void => {
		setChrome((previous) => {
			const next = { ...previous, ...patch };
			saveChrome(next);
			return next;
		});
	}, []);

	const nav = useKeyboardNav({
		appearanceRef,
		vimEnabledRef,
		vimModeRef,
		paletteOpenRef,
		layoutRef,
		updateLayout,
		openTabsRef,
		activePathRef,
		treeNavRef,
		editorRef,
		selectFile,
		toggleFolder,
		closeOtherTabs,
		expandTreeRoot: useCallback(
			() => setSrcCollapsed(false),
			[setSrcCollapsed],
		),
	});
	const { focusZone, leaderPending, treeSel, setFocusZone } = nav;

	const peekPanel = usePeekPanel({
		editorRef,
		valuesRef,
		values,
		stale,
		activePath,
	});
	const { peek, setPeek, peekOverride, setPeekOverride, peekNode } = peekPanel;

	// ── Session lifecycle ──
	// Opening a session is the same work on first load and on every
	// workspace switch: tear the old one down, ask for a new one, and let
	// the socket/LSP effects rebuild themselves around it.
	const requestSession = useCallback(
		(workspace: string | undefined): Promise<Response> =>
			fetch("/api/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					language: loadLanguage(),
					scaffold: loadScaffold(),
					...(workspace ? { workspace } : {}),
				}),
			}),
		[],
	);

	const openSession = useCallback(
		async (workspace: string | undefined): Promise<void> => {
			try {
				let response = await requestSession(workspace);
				// A stored workspace that no longer exists falls back to a
				// scratch session rather than failing the boot.
				if (!response.ok && workspace) {
					saveActiveWorkspace(undefined);
					response = await requestSession(undefined);
				}
				if (!response.ok)
					throw new Error(`Session creation failed (${response.status})`);
				const created = (await response.json()) as CreateSessionResponse;
				sessionRef.current = created;
				const entry = WEB_LANGUAGE_PACKS[created.language].entryFile;
				entryRef.current = entry;
				activeLanguageRef.current = created.language;
				resetToEntry(entry);
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
				// The kernel decides whether the sandbox can be honoured;
				// a stored preference never turns it on where it cannot run.
				if (created.sandboxSupport === "unsupported")
					setSettings((previous) => {
						const next = { ...previous, sandbox: false };
						settingsRef.current = next;
						return next;
					});
			} catch (error) {
				setStartupError(
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				setSwitching(false);
			}
		},
		[requestSession, resetToEntry],
	);

	const bootedRef = useRef(false);
	useEffect(() => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		void openSession(loadActiveWorkspace());
	}, [openSession]);

	const sendSettings = useCallback(
		(next: Settings): void => {
			settingsRef.current = next;
			setSettings(next);
			saveSettings(next);
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
			saveAppearance(merged);
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
	}, [activePathRef, sendRuntime, session]);
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
		saveVimMode(enabled);
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
			editor.executeEdits("atomis.clipboard", [
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
		[activePathRef],
	);

	const handleMount: OnMount = useCallback(
		(editor, monaco) => {
			if (!session) return;
			editorRef.current = editor;
			monacoRef.current = monaco;
			const model = editor.getModel();
			if (!model) return;
			filesRef.current = filesRef.current.map((file) =>
				file.path === entryRef.current
					? { ...file, source: model.getValue() }
					: file,
			);
			decorationsRef.current = editor.createDecorationsCollection();
			errorLensDecorationsRef.current = editor.createDecorationsCollection();
			logSourceDecorationsRef.current = editor.createDecorationsCollection();
			testLensDecorationsRef.current = editor.createDecorationsCollection();
			inlineLogDecorationsRef.current = editor.createDecorationsCollection();
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
			const vimCommands = VimMode as object as VimModeWithCommands;
			for (const shortcut of ["<C-a>", "<C-c>", "<C-v>", "<C-x>"])
				vimCommands.Vim.unmap(shortcut);
			vimCommands.Vim.unmap("<C-c>", "insert");
			vimCommands.Vim.defineEx("write", "w", run);
			installVimExtensions();
			if (vimEnabledRef.current && vimStatusRef.current)
				vimRef.current = initVimMode(
					editor,
					vimStatusRef.current,
					NvimStatusBar,
				);
			editor.onDidFocusEditorText(() => setFocusZone("editor"));
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

			// Nothing else claims the caret on load, so the window opens with
			// no place to type. The editor is what you came for.
			editor.focus();
		},
		[
			activePathRef,
			catalogRef,
			setFocusZone,
			openInLsp,
			run,
			sendSettings,
			session,
			setPeek,
		],
	);

	useEffect(() => {
		updateVimAppCommands({
			run,
			openOrCreateFile: (name) => {
				if (!name) {
					setPaletteOpen(true);
					return;
				}
				if (filesRef.current.some((file) => file.path === name))
					selectFile(name);
				else project.createFileNamed(name);
			},
			closeActiveTab: () => project.closeTab(activePathRef.current),
			closeOtherTabs: project.closeOtherTabs,
		});
	}, [activePathRef, project, run, selectFile]);

	useQuickScope({
		editorRef,
		cursor: cursorPosition,
		vimEnabled,
		vimModeLabel,
		activePath,
	});

	useEffect(() => {
		if (!session) return;
		const socket = new WebSocket(websocketUrl("/ws/runtime", session));
		runtimeRef.current = socket;
		socket.addEventListener("open", () => {
			sendRuntime({
				type: "settings.update",
				sessionId: session.sessionId,
				...settingsRef.current,
			});
			const mainSource =
				filesRef.current.find((file) => file.path === entryRef.current)
					?.source ?? session.initialSource;
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
		socket.addEventListener("message", (message) => {
			try {
				handleRuntimeEvent(JSON.parse(String(message.data)) as never);
			} catch (error) {
				setStatus(
					`Runtime protocol error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		socket.addEventListener("close", () => setStatus("Runtime disconnected"));
		return () => {
			// Closing here stops the old session's events from reaching the
			// new one; the server tears its side down on disconnect.
			socket.close();
			if (runtimeRef.current === socket) runtimeRef.current = undefined;
		};
	}, [handleRuntimeEvent, sendRuntime, session]);

	// Monaco models are keyed by absolute session paths, so the previous
	// workspace's models would linger after a switch. Drop anything that is
	// not under the current session's source root.
	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco || !session) return;
		const root = session.documentUri.slice(
			0,
			session.documentUri.lastIndexOf("/") + 1,
		);
		for (const model of monaco.editor.getModels())
			if (!model.uri.toString().startsWith(root)) model.dispose();
	}, [session]);

	useEditorDecorations({
		editorRef,
		monacoRef,
		decorationsRef,
		errorLensDecorationsRef,
		errorLensWidgetsRef,
		testLensDecorationsRef,
		testLensWidgetsRef,
		inlineLogDecorationsRef,
		entryRef,
		activePath,
		catalog,
		manualProbeIds: settings.manualProbeIds,
		values,
		stale,
		valueFmt,
		allProblems,
		tests,
		testResults,
		output,
		inlineLogs,
	});

	useEffect(
		() => () => {
			vimRef.current?.dispose();
			for (const client of Object.values(lspClientsRef.current))
				client?.dispose();
			runtimeRef.current?.close();
		},
		[],
	);

	const formatAndNormal = useCallback((): void => {
		const editor = editorRef.current;
		if (!editor) return;
		const vimCommands = VimMode as object as VimModeWithCommands;
		const adapter = vimRef.current as VimAdapterState | null;
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

	useGlobalShortcuts({
		paletteOpenRef,
		closePalette: useCallback(() => setPaletteOpen(false), []),
		run,
		toggleZen,
		toggleTree: useCallback(
			() =>
				updateLayout({ treeOpen: !layoutRef.current.treeOpen, zen: false }),
			[updateLayout],
		),
		toggleTerm: useCallback(
			() =>
				updateLayout({ termOpen: !layoutRef.current.termOpen, zen: false }),
			[updateLayout],
		),
		openPalette: useCallback(() => setPaletteOpen(true), []),
		formatDocument: formatAndNormal,
		toggleDrawer: useCallback(() => {
			setDrawer((previous) => !previous);
			updateLayout({ termOpen: true, zen: false });
		}, [setDrawer, updateLayout]),
		toggleSettings: useCallback(
			() => setSettingsOpen((previous) => !previous),
			[],
		),
		setValueFmtIndex: useCallback((index: number) => {
			const fmt = VALUE_FMTS[index];
			if (fmt) {
				setValueFmt(fmt);
				saveValueFmt(fmt);
			}
		}, []),
	});

	useDismissable(
		Boolean(editorContextMenu),
		".editor-context-menu",
		useCallback(() => setEditorContextMenu(undefined), []),
	);
	useDismissable(
		Boolean(project.treeContextMenu),
		".tree-context-menu",
		useCallback(
			() => setTreeContextMenu(undefined),
			[setTreeContextMenu],
		),
	);

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
			layout.zen ? "atomis-zen" : "atomis-dark",
		);
	}, [layout.zen, session]);

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
			if (path === entryRef.current) saveEntrySource(source);
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
		[activePathRef, sendRuntime, session, setStale],
	);

	const loadDemoWorkspace = useCallback((): void => {
		if (
			!window.confirm(
				"Load the demo workspace? Current files will be replaced by every language's example.",
			)
		)
			return;
		saveScaffold("demo");
		window.location.reload();
	}, []);

	const clearWorkspace = useCallback((): void => {
		const entry =
			WEB_LANGUAGE_PACKS[
				languageForPath(activePathRef.current) ?? activeLanguageRef.current
			].entryFile;
		if (
			!window.confirm(
				`Clear the workspace? Only a fresh ${entry} will remain.`,
			)
		)
			return;
		saveScaffold("minimal");
		window.location.reload();
	}, [activePathRef]);

	const refreshWorkspaces = useCallback(async (): Promise<void> => {
		try {
			setWorkspaces(await listWorkspaces());
		} catch (error) {
			setWorkspaceError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}, []);

	const openWorkspacePicker = useCallback((): void => {
		setWorkspaceError(undefined);
		setWorkspacePickerOpen(true);
		void refreshWorkspaces();
	}, [refreshWorkspaces]);

	// Switching workspace swaps every file on disk, so the session is
	// rebuilt — but in place: the page never reloads. Tear down what is
	// bound to the old session, then open the new one; the socket, LSP and
	// model effects rebuild themselves around it.
	const switchToWorkspace = useCallback(
		(id: string | undefined): void => {
			setWorkspacePickerOpen(false);
			// Re-opening the workspace you are already in would throw away a
			// live session (and flash the tree) to arrive exactly where you
			// started.
			if (id === sessionRef.current?.workspace?.id) return;
			saveActiveWorkspace(id);
			setSwitching(true);
			for (const client of Object.values(lspClientsRef.current))
				client?.dispose();
			lspClientsRef.current = {};
			runtimeRef.current?.close();
			resetRuntime();
			setCapabilities({});
			setPeek(null);
			setStatus("Opening workspace…");
			versionRef.current = 1;
			void openSession(id);
		},
		[openSession, resetRuntime, setPeek],
	);

	const runWorkspaceAction = useCallback(
		async (action: () => Promise<void>): Promise<void> => {
			setWorkspaceBusy(true);
			setWorkspaceError(undefined);
			try {
				await action();
			} catch (error) {
				setWorkspaceError(
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				setWorkspaceBusy(false);
			}
		},
		[],
	);

	// The manifest belongs to the session's language, so the catalog is
	// refreshed whenever either changes.
	useEffect(() => {
		if (!session) return;
		const timer = setTimeout(
			() => sendRuntime({ type: "deps.list", sessionId: session.sessionId }),
			200,
		);
		return () => clearTimeout(timer);
	}, [sendRuntime, session]);

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
		[highlightLogSource, selectFile],
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
		[selectFile],
	);

	if (startupError)
		return (
			<main className="startup">
				<img alt="" className="startup-logo" src="/logo.png" />
				<h1>Atomis</h1>
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
				<img alt="" className="startup-logo pulsing" src="/logo.png" />
				<h1>Atomis</h1>
				<p>Running environment doctor…</p>
			</main>
		);

	const busy = isBusy(runState);
	const active = isActive(runState);
	const zen = layout.zen;
	const dockEffective = narrow ? "bottom" : layout.dock;
	const treeVisible = !zen && layout.treeOpen && !tight;
	const termVisible = !zen && layout.termOpen;
	const failsByFile = computeFailsByFile(tests, testResults);
	const failingCount = totalFails(failsByFile);
	const treeRows = buildTreeRows({
		files: files.map((file) => file.path),
		collapsed: project.collapsedFolders,
		pendingFolders: project.pendingFolders,
		failsByFile: new Map(
			[...failsByFile.entries()].map(([path, count]) => [
				path.replace(/^src\//, ""),
				count,
			]),
		),
	});
	treeNavRef.current = project.srcCollapsed
		? []
		: treeRows.map((row) =>
				row.kind === "folder"
					? {
							kind: "folder" as const,
							path: row.path,
							collapsed: row.collapsed,
						}
					: { kind: "file" as const, path: row.path },
			);
	const outputRows = groupOutput(output);
	const testsDone = !busy && testSummary !== undefined;
	const tone = {
		tests: testsTone({ testsDone, testCount: tests.length, failingCount }),
		term: termTone({
			active,
			...(result !== undefined ? { result } : {}),
			failingCount,
		}),
		zen: zenTone({
			active,
			...(result !== undefined ? { result } : {}),
			failingCount,
		}),
	};
	const drawerScore = drawerScoreLabel({
		testCount: tests.length,
		testsDone,
		failingCount,
	});
	const drawerSub = drawerSubLabel({
		testCount: tests.length,
		testsDone,
		busy,
		failingCount,
		...(result !== undefined ? { executionMs: result.executionMs } : {}),
	});
	const activeLanguage =
		languageForPath(activePath) ?? activeLanguageRef.current;
	const runDisabled = Boolean(session.degraded[activeLanguage]);
	const [casesHintSource, casesHintEmpty] = TEST_HINTS[activeLanguage];
	const pack = WEB_LANGUAGE_PACKS[activeLanguage];
	const toggleAutoRun = (): void =>
		sendSettings({ ...settings, autoRun: !settings.autoRun });
	const visibleSource =
		activeFile?.source ?? session.initialSource ?? loadEntrySource() ?? "";
	const editorLanguage = monacoLanguageFor(activePath);
	const degradedMessages = Object.entries(session.degraded)
		.filter(([key]) => key.startsWith(activeLanguage))
		.map(([, message]) => message ?? "");
	const sandboxAvailable = session.sandboxSupport !== "unsupported";
	const sandboxHint = !sandboxAvailable
		? "needs Linux 6.7+ with Landlock"
		: session.sandboxSupport === "files"
			? "workspace-only files"
			: "workspace-only files · no TCP";
	const networkHint = !sandboxAvailable
		? "your code already runs unconfined here"
		: settings.sandbox
			? "your code may call out; files stay confined"
			: "sandbox off — the network is already open";
	const drawerToneFor = (testId: string): string =>
		caseTone(testsDone, testResults.get(testId));

	return (
		<main
			className={`app-shell${zen ? " zen" : ""} dock-${dockEffective}${layout.termMax ? " term-max" : ""}${switching ? " switching" : ""}`}
			data-theme={appearance.theme}
			style={{ fontFamily: APP_FONTS[appearance.fontIndex]?.css }}
		>
			<div className="workspace">
				{treeVisible && (
					<FileTree
						activeIsEntry={ENTRY_FILES.has(activePath)}
						activePath={activePath}
						draft={project.treeDraft}
						draftInvalid={project.treeDraftInvalid}
						draftValue={project.treeDraftValue}
						failsByFile={failsByFile}
						focused={focusZone === "tree"}
						onCreateFile={project.createFile}
						onCreateFolder={project.createFolder}
						onDeleteActive={() => project.deleteFile(activePathRef.current)}
						onDraftCancel={() => project.setTreeDraft(undefined)}
						onDraftChange={(value) => {
							project.setTreeDraftInvalid(false);
							project.setTreeDraftValue(value);
						}}
						onDraftCommit={project.commitTreeDraft}
						onHideTree={() => updateLayout({ treeOpen: false })}
						onLoadDemo={loadDemoWorkspace}
						onSwitchWorkspace={openWorkspacePicker}
						onClearWorkspace={clearWorkspace}
						onOpenContextMenu={project.setTreeContextMenu}
						onRenameActive={() => project.renameFile(activePathRef.current)}
						onSelect={selectFile}
						onToggleFolder={toggleFolder}
						onToggleSrc={() =>
							project.setSrcCollapsed((previous) => !previous)
						}
						revealKey={session.sessionId}
						scratch={!session.workspace}
						workspaceName={session.workspace?.name ?? "Scratch session"}
						rows={treeRows}
						srcCollapsed={project.srcCollapsed}
						treeSel={treeSel}
					/>
				)}

				<div className="inner">
					<section className="editor-card">
						{!zen && chrome.toolbar && (
							<EditorChrome
								active={active}
								activePath={activePath}
								autoRun={settings.autoRun}
								onCloseTab={project.closeTab}
								onOpenPalette={() => setPaletteOpen(true)}
								onOpenSettings={() => setSettingsOpen(true)}
								onRun={run}
								onSelect={selectFile}
								onShowTree={() => updateLayout({ treeOpen: true })}
								onStop={stop}
								onToggleAutoRun={toggleAutoRun}
								openTabs={openTabs}
								runDisabled={runDisabled}
								showTabs={tabsVisible(chrome, openTabs.length)}
								showTreeRestore={!treeVisible && !tight}
								stale={stale}
							/>
						)}
						<div className="editor-wrap">
							<Editor
								height="100%"
								path={activeFile?.uri ?? session.documentUri}
								language={editorLanguage}
								value={visibleSource}
								theme={zen ? "atomis-zen" : "atomis-dark"}
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
						<Terminal
							active={active}
							allProblems={allProblems}
							busy={busy}
							caseTone={drawerToneFor}
							dockEffective={dockEffective}
							drawer={drawer}
							drawerScore={drawerScore}
							entryFile={entryRef.current}
							focused={focusZone === "term"}
							lspLabel={
								Object.keys(capabilities[activeLanguage] ?? {})
									.filter((key) => capabilities[activeLanguage]?.[key])
									.join(", ") || status
							}
							narrow={narrow}
							onClearOutput={() => {
								setOutput([]);
								pinnedLogLocationRef.current = undefined;
								logSourceDecorationsRef.current?.clear();
							}}
							onCloseTerm={() => updateLayout({ termOpen: false })}
							onDock={(dock) => updateLayout({ dock, termMax: false })}
							onEntryClick={onEntryClick}
							onEntryHover={(location) => highlightLogSource(location)}
							onEntryLeave={() =>
								highlightLogSource(pinnedLogLocationRef.current)
							}
							onOpenDrawer={() => setDrawer(true)}
							onProblemJump={(item) =>
								jumpToLine(
									item.path ?? `src/${entryRef.current}`,
									item.line,
									item.column,
								)
							}
							depsBusy={
								depsState === "installing" || depsState === "removing"
							}
							depsCount={deps.length}
							depsPanel={
								<DepsPanel
									dependencies={deps}
									language={activeLanguage}
									onAdd={(name) =>
										sendRuntime({
											type: "deps.add",
											sessionId: session.sessionId,
											name,
										})
									}
									onOpenManifest={(manifest) => {
										// Manifests live beside src/, so the palette
										// cannot open them: show where they are.
										setStatus(`${manifest} lives in the workspace root`);
									}}
									onRemove={(name) =>
										sendRuntime({
											type: "deps.remove",
											sessionId: session.sessionId,
											name,
										})
									}
									output={depsOutput}
									runsUntrustedCode={depsUntrusted}
									sandboxed={settings.sandbox}
									state={depsState}
									supported={depsSupported}
									{...(depsError ? { error: depsError } : {})}
									{...(depsHint ? { inputHint: depsHint } : {})}
									{...(depsManifest ? { manifest: depsManifest } : {})}
								/>
							}
							onTab={setTab}
							onToggleDrawer={() => setDrawer((previous) => !previous)}
							onToggleFold={(key) =>
								setOpenFolds((previous) => {
									const next = new Set(previous);
									if (next.has(key)) next.delete(key);
									else next.add(key);
									return next;
								})
							}
							onToggleMax={() =>
								updateLayout({ termMax: !layout.termMax })
							}
							openFolds={openFolds}
							output={output}
							outputRows={outputRows}
							probesLabel={`${catalog.length} / ${values.size}`}
							runCommand={pack.runCommand}
							runStateLabel={RUN_STATE_LABELS[runState]}
							stageLabel={stageLabel(runState, activePath)}
							tab={tab}
							termMax={layout.termMax}
							termTone={tone.term}
							testCommand={pack.testCommand}
							tests={tests}
							testsLabel={
								testSummary
									? `${testSummary.passed} ok · ${testSummary.failed} err · ${testSummary.skipped} skip${testSummary.leaked ? ` · ${testSummary.leaked} leak` : ""}`
									: tests.length
										? `${tests.length} detected`
										: "—"
							}
							testsTone={tone.tests}
							toolchainLabel={
								session.toolchains?.[activeLanguage]?.run ??
								session.zigVersion
							}
							{...(result !== undefined ? { result } : {})}
						>
							<TestsDrawer
								caseTone={drawerToneFor}
								drawerScore={drawerScore}
								drawerSub={drawerSub}
								drawerTab={drawerTab}
								hintEmpty={casesHintEmpty}
								hintSource={casesHintSource}
								history={history}
								onClose={() => setDrawer(false)}
								onDrawerTab={setDrawerTab}
								onJump={(test) => jumpToLine(test.path, test.line, test.column)}
								onRun={run}
								testResults={testResults}
								tests={tests}
								testsTone={tone.tests}
							/>
						</Terminal>
					)}
				</div>
			</div>

			{project.treeContextMenu && (
				<TreeContextMenu
					menu={project.treeContextMenu}
					onClose={() => project.setTreeContextMenu(undefined)}
					onCreateFile={project.createFile}
					onCreateFolder={project.createFolder}
					onDelete={project.deleteFile}
					onOpen={selectFile}
					onRename={project.renameFile}
				/>
			)}
			{editorContextMenu && (
				<EditorContextMenu
					menu={editorContextMenu}
					onCopy={() => void copyFromEditor()}
					onPaste={() => void pasteIntoEditor()}
				/>
			)}

			{!chrome.statusBar && (
				// Vim writes its command line into this node, so it stays mounted
				// out of sight: hiding the bar must not quietly disable vim.
				<div className="vim-status-host">
					<div className="vim-status" ref={vimStatusRef} />
				</div>
			)}
			{chrome.statusBar && (
				<StatusBar
					activePath={activePath}
				onWorkspace={openWorkspacePicker}
				workspaceName={session.workspace?.name ?? "scratch"}
				cursor={cursorPosition}
				degradedMessages={degradedMessages}
				focusZone={focusZone}
				leaderPending={leaderPending}
				runState={runState}
				timingLabel={
					result
						? `run ${result.executionMs.toFixed(0)}ms · compile ${result.compilationMs.toFixed(0)}ms`
						: `${activeLanguage} · utf-8`
				}
				valuesCount={values.size}
				vimModeLabel={vimModeLabel}
				vimStatusRef={vimStatusRef}
				/>
			)}

			{zen && (
				<ZenPill
					active={active}
					onExit={toggleZen}
					onRun={run}
					onStop={stop}
					runDisabled={runDisabled}
					status={zenStatusLabel({
						active,
						runState,
						...(result !== undefined ? { result } : {}),
						...(testSummary !== undefined ? { testSummary } : {}),
						failingCount,
						testCount: tests.length,
					})}
					tone={tone.zen}
				/>
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
						saveValueFmt(fmt);
					}}
					leader={appearance.leader}
					onLeader={(leader) => updateAppearance({ leader })}
					sizeIndex={appearance.sizeIndex}
					theme={appearance.theme}
					toggles={[
						{
							label: "Auto Run",
							hint: "runs when you stop typing",
							on: settings.autoRun,
							disabled: runDisabled,
							act: toggleAutoRun,
						},
						{
							label: "Auto Inspect",
							hint: "inline values",
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
							label: "Inline logs",
							hint: "log output next to its line",
							on: inlineLogs,
							act: () => {
								setInlineLogs((previous) => {
									saveInlineLogs(!previous);
									return !previous;
								});
							},
						},
						{
							label: "Sandbox",
							hint: sandboxHint,
							on: settings.sandbox,
							disabled: !sandboxAvailable,
							act: () =>
								sendSettings({
									...settings,
									sandbox: !settings.sandbox,
								}),
						},
						{
							label: "Allow network",
							hint: networkHint,
							on: settings.network,
							disabled: !settings.sandbox && sandboxAvailable,
							act: () =>
								sendSettings({
									...settings,
									network: !settings.network,
								}),
						},
						{
							label: "Vim Mode",
							hint: "",
							on: vimEnabled,
							act: () => changeVimMode(!vimEnabled),
						},
						{
							label: "Toolbar",
							hint: "tabs, auto, settings and Run",
							on: chrome.toolbar,
							act: () => updateChrome({ toolbar: !chrome.toolbar }),
						},
						{
							label: "Status bar",
							hint: "mode, workspace and cursor along the bottom",
							on: chrome.statusBar,
							act: () => updateChrome({ statusBar: !chrome.statusBar }),
						},
						{
							label: "Hide tabs for one file",
							hint: "the strip appears once a second file opens",
							on: chrome.hideSingleTab,
							disabled: !chrome.toolbar,
							act: () =>
								updateChrome({ hideSingleTab: !chrome.hideSingleTab }),
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
			{workspacePickerOpen && (
				<WorkspacePicker
					activeId={session.workspace?.id}
					busy={workspaceBusy}
					language={activeLanguage}
					onClose={() => setWorkspacePickerOpen(false)}
					onCreate={(name) =>
						void runWorkspaceAction(async () => {
							const created = await createWorkspace({
								name,
								language: activeLanguage,
								scaffold: loadScaffold(),
							});
							switchToWorkspace(created.id);
						})
					}
					onDelete={(id) =>
						void runWorkspaceAction(async () => {
							if (
								!window.confirm(
									"Delete this workspace and every file in it?",
								)
							)
								return;
							await deleteWorkspace(id);
							if (id === session.workspace?.id) switchToWorkspace(undefined);
							else await refreshWorkspaces();
						})
					}
					onOpen={switchToWorkspace}
					onRename={(id, name) =>
						void runWorkspaceAction(async () => {
							await renameWorkspace(id, name);
							await refreshWorkspaces();
						})
					}
					onScratch={() => switchToWorkspace(undefined)}
					workspaces={workspaces}
					{...(workspaceError ? { error: workspaceError } : {})}
				/>
			)}
			{paletteOpen && (
				<CommandPalette
					activePath={activePath}
					commands={[
						{
							id: "settings",
							title: "Open settings",
							hint: "⌘,",
							act: () => {
								setPaletteOpen(false);
								setSettingsOpen(true);
							},
						},
					]}
					files={files}
					onClose={() => setPaletteOpen(false)}
					onCreate={(path) => {
						project.createFileNamed(path);
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
