import type { Monaco } from "@monaco-editor/react";
import { EditorPane } from "../features/editor/EditorPane.js";
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
} from "@atomis/protocol";
import type * as MonacoApi from "monaco-editor";
import { CommandPalette } from "./CommandPalette.js";
import {
	EditorContextMenu,
	TreeContextMenu,
} from "./ContextMenus.js";
import { Sidebar } from "../features/files/Sidebar.js";
import { PeekPanel } from "../features/editor/PeekPanel.js";
import { SettingsModal } from "../features/settings/SettingsModal.js";
import { StatusBar, ZenPill } from "./StatusBar.js";
import type { TerminalTab } from "../features/terminal/Terminal.js";
import { TerminalPane } from "../features/terminal/TerminalPane.js";
import { WorkspacePicker } from "../features/workspaces/WorkspacePicker.js";
import { updateVimAppCommands } from "../features/editor/vimExtensions.js";
import { useDismissable } from "../shared/ui/useDismissable.js";
import { useEditorDecorations } from "../features/editor/useEditorDecorations.js";
import { useGlobalShortcuts } from "./useGlobalShortcuts.js";
import { useKeyboardNav, type TreeNavRow } from "./useKeyboardNav.js";
import { useMediaLayout } from "./useMediaLayout.js";
import { usePeekPanel } from "../features/editor/usePeekPanel.js";
import { useQuickScope } from "../features/editor/useQuickScope.js";
import { useProjectFiles } from "../features/files/useProjectFiles.js";
import { useRuntimeEvents } from "../features/runtime/useRuntimeEvents.js";
import {
	ENTRY_FILES,
	languageForPath,
	monacoLanguageFor,
	WEB_LANGUAGE_PACKS,
} from "../features/editor/languagePacks.js";
import {
	parseIntegerPreview,
	VALUE_FMTS,
	type ValueFmt,
} from "../shared/lib/lowlevel.js";
import { LspClient } from "../features/editor/lsp/LspClient.js";
import { lspSeverityName, type JsonValue } from "../features/editor/lsp/protocol.js";
import {
	APPEARANCE_KEY,
	loadAppearance,
} from "../shared/stores/appearance.js";
import { flattenProblems, type OwnedDiagnostic } from "../shared/lib/diagnostics.js";
import { buildTreeRows } from "../shared/lib/fileTree.js";
import { websocketUrl } from "../shared/api/client.js";
import {
	computeFailsByFile,
	isActive,
	isBusy,
	TEST_HINTS,
	termTone,
	testsTone,
	totalFails,
	zenStatusLabel,
	zenTone,
} from "../shared/lib/runSummary.js";
import { type InlineValue } from "../shared/lib/runtimeState.js";
import {
	CHROME_KEY,
	loadChrome,
	saveChrome,
	tabsVisible,
	type ChromeSettings,
} from "../shared/stores/chrome.js";
import { subscribeToPreferences } from "../shared/stores/storage.js";
import { fontStack } from "../shared/lib/fonts.js";
import { useRuntimeSocket } from "../features/runtime/useRuntimeSocket.js";

import { useAppearance } from "../features/settings/useAppearance.js";
import { settingsToggles } from "../features/settings/toggles.js";
import { useVim } from "../features/editor/useVim.js";
import { useEditorMount } from "../features/editor/useEditorMount.js";
import { useEditorClipboard } from "../features/editor/useEditorClipboard.js";
import { useSourceNavigation } from "../features/editor/useSourceNavigation.js";
import { useWorkspaces } from "../features/workspaces/useWorkspaces.js";
import { useSessionLifecycle } from "../features/session/useSessionLifecycle.js";
import {
	INLINE_LOGS_KEY,
	SETTINGS_KEY,
	VALUE_FMT_KEY,
	VIM_MODE_KEY,
	loadEntrySource,
	loadInlineLogs,
	loadLayout,
	loadSettings,
	loadValueFmt,
	loadVimMode,
	saveEntrySource,
	saveLayout,
	saveScaffold,
	saveSettings,
	saveValueFmt,
	type LayoutState,
	type Settings,
} from "../shared/stores/settings.js";
import type { LogSourceLocation, ProjectFile } from "../shared/types.js";

export function App(): React.JSX.Element {
	const entryRef = useRef("main.zig");
	const [session, setSession] = useState<CreateSessionResponse>();
	const [files, setFiles] = useState<ProjectFile[]>([]);
	const [startupError, setStartupError] = useState<string>();
	const [settings, setSettings] = useState<Settings>(loadSettings);
	const [valueFmt, setValueFmt] = useState<ValueFmt>(loadValueFmt);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [status, setStatus] = useState("Starting…");
	const [tab, setTab] = useState<TerminalTab>("output");
	const [drawerTab, setDrawerTab] = useState<"tests" | "hist">("tests");
	const [capabilities, setCapabilities] = useState<
		Partial<Record<Language, Record<string, JsonValue>>>
	>({});
	const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
	const [inlineLogs, setInlineLogs] = useState(loadInlineLogs);
	const [editorContextMenu, setEditorContextMenu] = useState<{
		x: number;
		y: number;
	}>();
	const [layout, setLayout] = useState<LayoutState>(loadLayout);
	const [chrome, setChrome] = useState<ChromeSettings>(loadChrome);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
	const [switching, setSwitching] = useState(false);


	const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | undefined>(
		undefined,
	);
	const monacoRef = useRef<Monaco | undefined>(undefined);

	const {
		vimEnabled,
		vimEnabledRef,
		vimModeLabel,
		vimModeRef,
		vimStatusRef,
		changeVimMode,
		syncVimEnabled,
		setupVimKeys,
		attachVim,
		formatAndNormal,
		disposeVim,
	} = useVim({ editorRef });

	const {
		appearance,
		appearanceRef,
		updateAppearance,
		activeTheme,
		palette,
		previewTheme,
		setPreviewTheme,
		setAppearance,
	} = useAppearance({ monacoRef, zen: layout.zen, session });

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
				if (changed.has(VIM_MODE_KEY)) syncVimEnabled(loadVimMode());
				if (changed.has(INLINE_LOGS_KEY)) setInlineLogs(loadInlineLogs());
				if (changed.has(CHROME_KEY)) setChrome(loadChrome());
			}),
		[setAppearance, syncVimEnabled],
	);

	const lspClientsRef = useRef<Partial<Record<Language, LspClient>>>({});
	const sessionRef = useRef<CreateSessionResponse | undefined>(undefined);
	const activeLanguageRef = useRef<Language>("zig");
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

	/**
	 * The one way to change the file list: the ref keeps callbacks reading
	 * the current value, the state makes the UI render it, and writing only
	 * one of them is how they drift apart.
	 */
	const setProjectFiles = useCallback(
		(next: ProjectFile[] | ((previous: ProjectFile[]) => ProjectFile[])) => {
			const value =
				typeof next === "function" ? next(filesRef.current) : next;
			filesRef.current = value;
			setFiles(value);
		},
		[],
	);
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
		setProjectFiles,
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
		peers,
		revisionRef,
		conflict,
		setConflict,
		remoteEdit,
		output,
		setOutput,
		setDiagnostics,
		result,
		tests,
		testResults,
		testSummary,
		setDrawer,
		setOpenFolds,
		handleRuntimeEvent,
	} = runtime;

	const allProblems = useMemo<OwnedDiagnostic[]>(
		() => flattenProblems(runtime.diagnostics),
		[runtime.diagnostics],
	);

	const { sendRuntime, closeRuntime } = useRuntimeSocket({
		session,
		handleRuntimeEvent,
		settingsRef,
		filesRef,
		entryRef,
		versionRef,
		lspClientsRef,
		setStatus,
	});

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
		setProjectFiles,
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

	/**
	 * A file another session sharing this workspace changed.
	 *
	 * Applied unless the caret is in that very file: taking text out from
	 * under someone's hands is worse than telling them. In that case the
	 * status bar says so, and their next write is refused by the server
	 * anyway — which is what the revision is for.
	 */
	useEffect(() => {
		if (!remoteEdit) return;
		const { path, source } = remoteEdit;
		if (
			activePathRef.current === path &&
			editorRef.current?.hasTextFocus() === true
		) {
			setConflict(path);
			return;
		}
		setProjectFiles((previous) =>
			previous.map((file) => (file.path === path ? { ...file, source } : file)),
		);
		const model = editorRef.current?.getModel();
		if (activePathRef.current === path && model && model.getValue() !== source)
			model.setValue(source);
	}, [activePathRef, remoteEdit, setConflict, setProjectFiles]);


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
	const { switchToWorkspace, boot } = useSessionLifecycle({
		activeLanguageRef,
		closePicker: useCallback(() => setWorkspacePickerOpen(false), []),
		closeRuntime,
		entryRef,
		lspClientsRef,
		resetRuntime,
		resetToEntry,
		sessionRef,
		setCapabilities,
		setPeek,
		setProjectFiles,
		setSession,
		setSettings,
		setStartupError,
		setStatus,
		setSwitching,
		settingsRef,
		versionRef,
	});

	useEffect(boot, [boot]);

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

	const { copyFromEditor, pasteIntoEditor } = useEditorClipboard({
		editorRef,
		setEditorContextMenu,
		setStatus,
	});

	const { highlightLogSource, onEntryClick, jumpToLine } = useSourceNavigation({
		editorRef,
		activePathRef,
		entryRef,
		logSourceDecorationsRef,
		pinnedLogLocationRef,
		selectFile,
	});

	const handleMount = useEditorMount({
		session,
		editorRef,
		monacoRef,
		entryRef,
		activePathRef,
		catalogRef,
		settingsRef,
		decorationsRef,
		errorLensDecorationsRef,
		logSourceDecorationsRef,
		testLensDecorationsRef,
		inlineLogDecorationsRef,
		setProjectFiles,
		setCursorPosition,
		setEditorContextMenu,
		setPeek,
		setFocusZone,
		openInLsp,
		setupVimKeys,
		attachVim,
		sendSettings,
		run,
	});

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
			disposeVim();
			for (const client of Object.values(lspClientsRef.current))
				client?.dispose();
			closeRuntime();
		},
		[closeRuntime, disposeVim],
	);

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
			setProjectFiles(nextFiles);
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
				// What this edit was built on, so a shared workspace can
				// refuse it rather than let it replace someone else's work.
				...(revisionRef.current === undefined
					? {}
					: { baseRevision: revisionRef.current }),
			});
		},
		[activePathRef, revisionRef, sendRuntime, session, setProjectFiles, setStale],
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

	// Switching workspace swaps every file on disk, so the session is
	// rebuilt — but in place: the page never reloads. Tear down what is
	// bound to the old session, then open the new one; the socket, LSP and
	// model effects rebuild themselves around it.
	// The picker's own state lives with the picker; switching does not,
	// because it tears down the socket, the language clients and the models,
	// and only the shell holds all three. The ref is what lets the hook call
	// back into something declared after it.
	const switchToWorkspaceRef = useRef(switchToWorkspace);
	switchToWorkspaceRef.current = switchToWorkspace;

	const {
		workspaces,
		workspacesBusy,
		workspaceError,
		refreshWorkspaces,
		createNamedWorkspace,
		deleteNamedWorkspace,
		renameNamedWorkspace,
	} = useWorkspaces({
		switchToWorkspace: useCallback(
			(id: string | undefined) => switchToWorkspaceRef.current(id),
			[],
		),
	});

	const openWorkspacePicker = useCallback((): void => {
		setWorkspacePickerOpen(true);
		void refreshWorkspaces();
	}, [refreshWorkspaces]);


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

	return (
		<main
			className={`app-shell${zen ? " zen" : ""} dock-${dockEffective}${layout.termMax ? " term-max" : ""}${switching ? " switching" : ""}`}
			data-theme={activeTheme}
			style={{ fontFamily: fontStack(appearance.font) }}
		>
			<div className="workspace">
				{treeVisible && (
					<Sidebar
						activeIsEntry={ENTRY_FILES.has(activePath)}
						activePath={activePath}
						failsByFile={failsByFile}
						focused={focusZone === "tree"}
						onClearWorkspace={clearWorkspace}
						onHideTree={() => updateLayout({ treeOpen: false })}
						onLoadDemo={loadDemoWorkspace}
						onSelect={selectFile}
						onSwitchWorkspace={openWorkspacePicker}
						onToggleFolder={toggleFolder}
						project={project}
						revealKey={session.sessionId}
						rows={treeRows}
						scratch={!session.workspace}
						treeSel={treeSel}
						workspaceName={session.workspace?.name ?? "Scratch session"}
					/>
				)}

				<div className="inner">
					<EditorPane
						appearance={appearance}
						chrome={
							!zen && chrome.toolbar
								? {
										active,
										activePath,
										autoRun: settings.autoRun,
										onCloseTab: project.closeTab,
										onOpenPalette: () => setPaletteOpen(true),
										onOpenSettings: () => setSettingsOpen(true),
										onRun: run,
										onSelect: selectFile,
										onShowTree: () => updateLayout({ treeOpen: true }),
										onStop: stop,
										onToggleAutoRun: toggleAutoRun,
										openTabs,
										runDisabled,
										showTabs: tabsVisible(chrome, openTabs.length),
										showTreeRestore: !treeVisible && !tight,
										stale,
									}
								: undefined
						}
						language={editorLanguage}
						onChange={onChange}
						onMount={handleMount}
						palette={palette}
						path={activeFile?.uri ?? session.documentUri}
						value={visibleSource}
						zen={zen}
					/>

					{termVisible && (
						<TerminalPane
							activeLanguage={activeLanguage}
							activePath={activePath}
							allProblems={allProblems}
							failsByFile={failsByFile}
							casesHintEmpty={casesHintEmpty}
							casesHintSource={casesHintSource}
							dockEffective={dockEffective}
							drawerTab={drawerTab}
							entryFile={entryRef.current}
							focused={focusZone === "term"}
							highlightLogSource={(location) => highlightLogSource(location)}
							jumpToLine={jumpToLine}
							lspLabel={
								Object.keys(capabilities[activeLanguage] ?? {})
									.filter((key) => capabilities[activeLanguage]?.[key])
									.join(", ") || status
							}
							narrow={narrow}
							onAddDependency={(name) =>
								sendRuntime({
									type: "deps.add",
									sessionId: session.sessionId,
									name,
								})
							}
							onClearOutput={() => {
								setOutput([]);
								pinnedLogLocationRef.current = undefined;
								logSourceDecorationsRef.current?.clear();
							}}
							onCloseTerm={() => updateLayout({ termOpen: false })}
							onDock={(dock) => updateLayout({ dock, termMax: false })}
							onEntryClick={onEntryClick}
							onEntryLeave={() =>
								highlightLogSource(pinnedLogLocationRef.current)
							}
							onOpenManifest={(manifest) => {
								// Manifests live beside src/, so the palette cannot
								// open them: show where they are.
								setStatus(`${manifest} lives in the workspace root`);
							}}
							onRemoveDependency={(name) =>
								sendRuntime({
									type: "deps.remove",
									sessionId: session.sessionId,
									name,
								})
							}
							onToggleFold={(key) =>
								setOpenFolds((previous) => {
									const next = new Set(previous);
									if (next.has(key)) next.delete(key);
									else next.add(key);
									return next;
								})
							}
							onToggleMax={() => updateLayout({ termMax: !layout.termMax })}
							pack={pack}
							run={run}
							runtime={runtime}
							sandboxed={settings.sandbox}
							setDrawerTab={setDrawerTab}
							setTab={setTab}
							tab={tab}
							termMax={layout.termMax}
							toolchainLabel={
								session.toolchains?.[activeLanguage]?.run ??
								session.zigVersion
							}
						/>
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
				peers={peers}
				valuesCount={values.size}
				{...(conflict ? { conflict } : {})}
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
					font={appearance.font}
					onClose={() => {
						setPreviewTheme(undefined);
						setSettingsOpen(false);
					}}
					onFont={(font) => updateAppearance({ font })}
					onSize={(fontSize) => updateAppearance({ fontSize })}
					onPreview={setPreviewTheme}
					onTheme={(theme) => {
						setPreviewTheme(undefined);
						updateAppearance({ theme });
					}}
					previewTheme={previewTheme}
					onValueFmt={(fmt) => {
						setValueFmt(fmt);
						saveValueFmt(fmt);
					}}
					leader={appearance.leader}
					onLeader={(leader) => updateAppearance({ leader })}
					fontSize={appearance.fontSize}
					theme={appearance.theme}
					toggles={settingsToggles({
						settings,
						sendSettings,
						run,
						runDisabled,
						toggleAutoRun,
						inlineLogs,
						setInlineLogs,
						chrome,
						updateChrome,
						vimEnabled,
						changeVimMode,
						zen,
						toggleZen,
						setSettingsOpen,
						sandboxAvailable,
						sandboxHint,
						networkHint,
					})}
					valueFmt={valueFmt}
				/>
			)}
			{workspacePickerOpen && (
				<WorkspacePicker
					activeId={session.workspace?.id}
					busy={workspacesBusy}
					language={activeLanguage}
					onClose={() => setWorkspacePickerOpen(false)}
					onCreate={(name) => createNamedWorkspace(name, activeLanguage)}
					onDelete={(id) =>
						deleteNamedWorkspace(id, id === session.workspace?.id)
					}
					onOpen={switchToWorkspace}
					onRename={renameNamedWorkspace}
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
