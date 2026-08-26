import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AppDiagnostic,
	CreateSessionResponse,
	ProbeDescriptor,
	RunResult,
	RunState,
	RuntimeServerEvent,
} from "@ziglive/protocol";
import type * as MonacoApi from "monaco-editor";
import {
	initVimMode,
	StatusBar as VimStatusBar,
	VimMode,
	type VimAdapterInstance,
} from "monaco-vim";
import { registerZig } from "./editor/zigLanguage.js";
import { LspClient } from "./lsp/LspClient.js";
import {
	acceptsVersion,
	toggleProbe,
	updateInlineValue,
	type InlineValue,
} from "./state/runtimeState.js";

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
	};
}

class NvimStatusBar extends VimStatusBar {
	override setMode(event: { mode: string; subMode?: string }): void {
		const suffix =
			event.mode === "visual" && event.subMode
				? ` ${event.subMode.replace("wise", "").toUpperCase()}`
				: "";
		this.setText(`${event.mode.toUpperCase()}${suffix}`);
	}
}

const RUN_STATE_LABELS: Record<RunState, string> = {
	idle: "listo",
	debouncing: "esperando",
	instrumenting: "inspeccionando",
	compiling: "compilando",
	running: "ejecutando",
	succeeded: "listo",
	compile_error: "error",
	runtime_error: "error",
	timed_out: "timeout",
	cancelled: "cancelado",
};

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
const SOURCE_KEY = "ziglive.source.v1";
const VIM_MODE_KEY = "ziglive.vim-mode.v1";

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

function websocketUrl(path: string, session: CreateSessionResponse): string {
	const url = new URL(path, window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("sessionId", session.sessionId);
	url.searchParams.set("token", session.authToken);
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
	const [session, setSession] = useState<CreateSessionResponse>();
	const [files, setFiles] = useState<ProjectFile[]>([]);
	const [activePath, setActivePath] = useState("main.zig");
	const [openTabs, setOpenTabs] = useState(["main.zig"]);
	const [startupError, setStartupError] = useState<string>();
	const [settings, setSettings] = useState<Settings>(loadSettings);
	const [runState, setRunState] = useState<RunState>("idle");
	const [status, setStatus] = useState("Starting…");
	const [catalog, setCatalog] = useState<ProbeDescriptor[]>([]);
	const [values, setValues] = useState<Map<string, InlineValue>>(new Map());
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
	const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
	const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
	const [vimEnabled, setVimEnabled] = useState(
		() => localStorage.getItem(VIM_MODE_KEY) !== "false",
	);
	const [editorContextMenu, setEditorContextMenu] = useState<{
		x: number;
		y: number;
	}>();
	const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | undefined>(
		undefined,
	);
	const monacoRef = useRef<Monaco | undefined>(undefined);
	const runtimeRef = useRef<WebSocket | undefined>(undefined);
	const lspRef = useRef<LspClient | undefined>(undefined);
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
	const activePathRef = useRef("main.zig");
	const settingsRef = useRef(settings);
	const catalogRef = useRef<ProbeDescriptor[]>([]);
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
			body: "{}",
		})
			.then(async (response) => {
				if (!response.ok)
					throw new Error(`Session creation failed (${response.status})`);
				return (await response.json()) as CreateSessionResponse;
			})
			.then((created) => {
				const projectFiles = (
					created as CreateSessionResponse & { files?: ProjectFile[] }
				).files ?? [
					{
						path: "main.zig",
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

	const run = useCallback((): void => {
		if (session)
			sendRuntime({
				type: "run.request",
				sessionId: session.sessionId,
				version: versionRef.current,
				reason: "manual",
			});
	}, [sendRuntime, session]);
	const stop = useCallback((): void => {
		if (session)
			sendRuntime({ type: "run.cancel", sessionId: session.sessionId });
	}, [sendRuntime, session]);

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
			if (!acceptsVersion(versionRef.current, projectEvent.documentVersion)) return;
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
				setDiagnostics((previous) => ({
					...previous,
					"zig-compiler": [],
					"zig-runtime": [],
					"ziglive-instrumenter": [],
				}));
				const monaco = monacoRef.current;
				if (monaco)
					for (const model of monaco.editor.getModels())
						for (const owner of [
							"zig-compiler",
							"zig-runtime",
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
						...(sourceLocation
							? { sourceLocation }
							: {}),
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
							.filter((item) => (item.path ?? "src/main.zig") === path)
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
		} else if (event.type === "run.finished") setResult(event.result);
		else if (event.type === "server.error") setStatus(event.message);
	}, []);

	const handleMount: OnMount = useCallback(
		(editor, monaco) => {
			if (!session) return;
			editorRef.current = editor;
			monacoRef.current = monaco;
			const model = editor.getModel();
			if (!model) return;
			filesRef.current = filesRef.current.map((file) =>
				file.path === "main.zig" ? { ...file, source: model.getValue() } : file,
			);
			decorationsRef.current = editor.createDecorationsCollection();
			errorLensDecorationsRef.current = editor.createDecorationsCollection();
			logSourceDecorationsRef.current = editor.createDecorationsCollection();
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
					filesRef.current.find((file) => file.path === "main.zig")?.source ??
					session.initialSource;
				if (mainSource !== session.initialSource) {
					versionRef.current = 2;
					sendRuntime({
						type: "document.update",
						sessionId: session.sessionId,
						version: 2,
						path: "main.zig",
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

			const workspaceUri = session.documentUri.slice(
				0,
				session.documentUri.lastIndexOf("/"),
			);
			const lsp = new LspClient(
				monaco,
				model,
				workspaceUri,
				setCapabilities,
				(uri, items) => {
					const path = filesRef.current.find((file) => file.uri === uri)?.path;
					setDiagnostics((previous) => ({
						...previous,
						[`zls:${path ?? uri}`]: items.map((item) => ({
							...(path ? { path: `src/${path}` } : {}),
							message: item.message,
							severity:
								item.severity === 2
									? "warning"
									: item.severity === 3
										? "information"
										: item.severity === 4
											? "hint"
											: "error",
							line: item.range.start.line + 1,
							column: item.range.start.character + 1,
							endLine: item.range.end.line + 1,
							endColumn: item.range.end.character + 1,
							...(item.code !== undefined ? { code: item.code } : {}),
							source: item.source ?? "zls",
						})),
					}));
				},
				setStatus,
			);
			lspRef.current = lsp;
			lsp.connect(websocketUrl("/ws/lsp", session), versionRef.current);

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
		[handleRuntimeEvent, run, sendRuntime, sendSettings, session],
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
						"src/main.zig") === `src/${activePath}` &&
					probe.originalRange.startLine <= lineCount,
			)
			.map((probe) => {
				const selected = settings.manualProbeIds.includes(probe.probeId);
				const value =
					probe.insertionByte !== undefined
						? values.get(probe.probeId)
						: undefined;
				const content = value
					? `  ${value.preview} : ${value.typeName}${value.count > 1 ? ` ×${value.count}` : ""}`
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
	}, [activePath, catalog, settings.manualProbeIds, stale, values]);

	useEffect(() => {
		const editor = editorRef.current;
		const decorations = errorLensDecorationsRef.current;
		const monaco = monacoRef.current;
		const model = editor?.getModel();
		if (!editor || !decorations || !monaco || !model) return;

		const byLine = new Map<number, OwnedDiagnostic[]>();
		for (const diagnostic of allProblems) {
			if (
				(diagnostic.path ?? "src/main.zig") !== `src/${activePath}` ||
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

	useEffect(
		() => () => {
			vimRef.current?.dispose();
			lspRef.current?.dispose();
			runtimeRef.current?.close();
		},
		[],
	);

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
		setTimeout(() => {
			const model = monacoRef.current?.editor.getModel(
				monacoRef.current.Uri.parse(file.uri),
			);
			if (model && path.endsWith(".zig"))
				lspRef.current?.open(model, versionRef.current);
		}, 0);
	}, []);

	const createFile = useCallback((): void => {
		if (!session) return;
		const path = window.prompt("Ruta del nuevo archivo (relativa a src/):")?.trim();
		if (!path) return;
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

	const renameActiveFile = useCallback((): void => {
		if (!session || activePathRef.current === "main.zig") return;
		const path = activePathRef.current;
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
		activePathRef.current = newPath;
		setActivePath(newPath);
		lspRef.current?.close(current.uri);
		const version = ++versionRef.current;
		sendRuntime({
			type: "file.rename",
			sessionId: session.sessionId,
			version,
			path,
			newPath,
		});
	}, [sendRuntime, session]);

	const deleteActiveFile = useCallback((): void => {
		if (!session || activePathRef.current === "main.zig") return;
		const path = activePathRef.current;
		if (!window.confirm(`¿Eliminar src/${path}?`)) return;
		const current = filesRef.current.find((file) => file.path === path);
		if (!current) return;
		filesRef.current = filesRef.current.filter((file) => file.path !== path);
		setFiles(filesRef.current);
		setOpenTabs((previous) => previous.filter((tab) => tab !== path));
		activePathRef.current = "main.zig";
		setActivePath("main.zig");
		lspRef.current?.close(current.uri);
		monacoRef.current?.editor.getModel(monacoRef.current.Uri.parse(current.uri))?.dispose();
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
		if (!activeFile?.path.endsWith(".zig")) return;
		const timer = setTimeout(() => {
			const monaco = monacoRef.current;
			if (!monaco) return;
			const model = monaco.editor.getModel(monaco.Uri.parse(activeFile.uri));
			if (model) lspRef.current?.open(model, versionRef.current);
		}, 0);
		return () => clearTimeout(timer);
	}, [activeFile]);
	const visibleSource =
		activeFile?.source ?? session?.initialSource ?? localStorage.getItem(SOURCE_KEY) ?? "";
	const editorLanguage = activePath.endsWith(".zig")
		? "zig"
		: activePath.endsWith(".json")
			? "json"
			: activePath.endsWith(".md")
				? "markdown"
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
			if (path === "main.zig") localStorage.setItem(SOURCE_KEY, source);
			const version = ++versionRef.current;
			setStale(true);
			const model = editorRef.current?.getModel();
			if (model && path.endsWith(".zig"))
				lspRef.current?.change(model, version, source);
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
	const busy = ["debouncing", "instrumenting", "compiling", "running"].includes(
		runState,
	);

	return (
		<main className="app-shell">
			<header className="buffer-tabs">
				{openTabs.map((path) => (
					<button
						className={`buffer-tab${path === activePath ? " active" : ""}`}
						key={path}
						onClick={() => selectFile(path)}
					>
						<i /> {path} <b>{stale && path === activePath ? "[+]" : ""}</b>
					</button>
				))}
				<div className="buffer-spacer" />
				<span>zig {session.zigVersion}</span>
				<span>zls</span>
				<strong>⏻ local</strong>
			</header>

			<div className="workspace">
				<aside className="navigator">
					<header>
						<strong>ZigLive</strong>
						<span>NVIM-TREE</span>
					</header>
					<div className="tree-actions">
						<button onClick={createFile} title="Crear archivo">
							＋
						</button>
						<button
							disabled={activePath === "main.zig"}
							onClick={renameActiveFile}
							title="Renombrar archivo"
						>
							✎
						</button>
						<button
							disabled={activePath === "main.zig"}
							onClick={deleteActiveFile}
							title="Eliminar archivo"
						>
							×
						</button>
					</div>
					<div className="file-tree">
						<div className="tree-root">⌄ ziglive-session</div>
						<div className="tree-folder">⌄ src</div>
						{files.map((file) => (
							<button
								className={`tree-file${file.path === activePath ? " active" : ""}`}
								key={file.path}
								onClick={() => selectFile(file.path)}
							>
								◆ {file.path}
							</button>
						))}
						<div className="tree-file generated">◇ generated/</div>
					</div>
					<div className="navigator-actions">
						<div>
							<button
								className="run-button"
								onClick={run}
								disabled={Boolean(session.degraded.zig)}
							>
								▶ Run
							</button>
							<button onClick={stop} disabled={!busy}>
								■
							</button>
						</div>
						<label>
							<input
								type="checkbox"
								checked={settings.autoRun}
								disabled={Boolean(session.degraded.zig)}
								onChange={(event) =>
									sendSettings({
										...settings,
										autoRun: event.target.checked,
									})
								}
							/>
							Auto Run
						</label>
						<label>
							<input
								type="checkbox"
								checked={settings.autoInspect}
								onChange={(event) => {
									sendSettings({
										...settings,
										autoInspect: event.target.checked,
									});
									setTimeout(run, 0);
								}}
							/>
							Auto Inspect
						</label>
						<label className="vim-toggle">
							<input
								type="checkbox"
								checked={vimEnabled}
								onChange={(event) => changeVimMode(event.target.checked)}
							/>
							Vim Mode
						</label>
					</div>
					<div className={vimEnabled ? "shortcut-help" : "shortcut-help dim"}>
						<span>
							<b>i</b> insert
						</span>
						<span>
							<b>:w</b> compilar
						</span>
						<span>
							<b>Esc</b> normal
						</span>
						<span>
							<b>⌘↵</b> ejecutar
						</span>
					</div>
				</aside>

				<section className="editor-pane">
					<header className="pane-header editor-header">
						<span>
							<b>src/{activePath}</b>
						</span>
					</header>
					<div className="editor-wrap">
						<Editor
							height="100%"
							path={activeFile?.uri ?? session.documentUri}
							language={editorLanguage}
							value={visibleSource}
							theme="ziglive-dark"
							beforeMount={registerZig}
							onMount={handleMount}
							onChange={onChange}
							options={{
								automaticLayout: true,
								fontFamily:
									'"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
								fontLigatures: true,
								fontSize: 13,
								glyphMargin: true,
								inlineSuggest: { enabled: true },
								lineHeight: 22,
								minimap: { enabled: false },
								overviewRulerBorder: false,
								padding: { top: 11 },
								renderLineHighlight: "none",
								scrollBeyondLastLine: false,
							}}
						/>
					</div>
				</section>

				<section className="side-panel">
					<header className="pane-header terminal-header">
						<span>
							<b>[Terminal]</b> term://zig-run
						</span>
						<strong>
							{result?.exitCode === null || result?.exitCode === undefined
								? RUN_STATE_LABELS[runState]
								: `exit ${result.exitCode}`}
						</strong>
					</header>

					<div className="panel-content">
						{tab === "output" && (
							<div className="output-list">
								<div className="terminal-command">
									<b>$</b> zig run src/main.zig
								</div>
								{output.length ? (
									output.map((entry, index) => (
										<div
											className={`output-entry${entry.sourceLocation ? " has-source" : ""}`}
											key={index}
											onClick={() => {
												if (!entry.sourceLocation) return;
												const path = (entry.sourceLocation.path ?? "src/main.zig").replace(/^src\//, "");
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
													const path = (entry.sourceLocation.path ?? "src/main.zig").replace(/^src\//, "");
													selectFile(path);
													pinnedLogLocationRef.current = entry.sourceLocation;
													setTimeout(() => highlightLogSource(entry.sourceLocation, true), 0);
												}
											}}
											onMouseEnter={() =>
												highlightLogSource(entry.sourceLocation)
											}
											onMouseLeave={() =>
												highlightLogSource(pinnedLogLocationRef.current)
											}
											role={entry.sourceLocation ? "button" : undefined}
											tabIndex={entry.sourceLocation ? 0 : undefined}
											title={
												entry.sourceLocation
													? `Generado por ${entry.sourceLocation.path ?? "src/main.zig"}:${entry.sourceLocation.line}:${entry.sourceLocation.column} · ejecución #${entry.sourceLocation.executionIndex}`
													: undefined
											}
										>
											<time>
												{(
													(entry.receivedAt -
														(output[0]?.receivedAt ?? entry.receivedAt)) /
													1000
												).toFixed(3)}
												s
											</time>
											<span className="output-chevron">›</span>
											<pre className={entry.category}>{entry.chunk}</pre>
											{entry.sourceLocation && (
												<span className="log-origin-tooltip">
													↳ {entry.sourceLocation.path ?? "src/main.zig"}:{entry.sourceLocation.line}:
													{entry.sourceLocation.column} · ejecución #
													{entry.sourceLocation.executionIndex}
													{entry.sourceLocation.loop && (
														<>
															{" "}· bucle {entry.sourceLocation.loop.line}:
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
									))
								) : (
									<p className="empty-state">La salida aparecerá aquí.</p>
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
													selectFile((item.path ?? "src/main.zig").replace(/^src\//, ""));
													setTimeout(() => {
														editorRef.current?.setPosition({
															lineNumber: item.line,
															column: item.column,
														});
														editorRef.current?.revealLineInCenter(item.line);
														editorRef.current?.focus();
													}, 0);
												}}
											>
												<i>{item.severity === "error" ? "×" : "△"}</i>
												<span>{item.message}</span>
												<small>
													{item.path ?? "src/main.zig"} · {item.owner} · Ln {item.line}, Col {item.column}
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
								<span>ZLS</span>
								<b className="capabilities">
									{Object.keys(capabilities)
										.filter((key) => capabilities[key])
										.join(", ") || status}
								</b>
							</div>
						)}
					</div>

					<nav className="pane-header panel-tabs">
						<div>
							<button
								aria-label="Output"
								className={tab === "output" ? "active" : ""}
								onClick={() => setTab("output")}
							>
								Terminal
							</button>
							<button
								aria-label={`Problems (${allProblems.length})`}
								className={tab === "problems" ? "active" : ""}
								onClick={() => setTab("problems")}
							>
								Diagnostics
							</button>
							<button
								className={tab === "runtime" ? "active" : ""}
								onClick={() => setTab("runtime")}
							>
								Runtime
							</button>
						</div>
						{tab === "output" && (
							<button
								className="clear-button"
								onClick={() => {
									setOutput([]);
									pinnedLogLocationRef.current = undefined;
									logSourceDecorationsRef.current?.clear();
								}}
							>
								:clear
							</button>
						)}
					</nav>
				</section>
			</div>

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
				<div className="vim-mode-slot">
					<div className="vim-status" ref={vimStatusRef} />
					{!vimEnabled && <span className="vim-disabled">VIM OFF</span>}
				</div>
				<span className="branch-status">
					⌁ main <b>+{values.size}</b> <i>-{allProblems.length}</i>
				</span>
				<span className={`run-state state-${runState}`}>
					{RUN_STATE_LABELS[runState]}
				</span>
				<span className="status-path">src/{activePath}</span>
				<span className="status-spacer" />
				<span>
					{result
						? `${result.compilationMs.toFixed(0)}ms · ${result.executionMs.toFixed(0)}ms`
						: "—"}
				</span>
				<span className="encoding">zig · utf-8 · unix</span>
				<strong className="cursor-status">
					{cursorPosition.line}:{cursorPosition.column}
				</strong>
			</footer>
			<div className="command-line">
				<span>› pulsa i para insertar · :w ejecutar · Ctrl+Enter ejecutar</span>
				<span>
					{Object.keys(session.degraded).length
						? Object.values(session.degraded).join(" · ")
						: `src/${activePath} ${visibleSource.split("\n").length}L`}
				</span>
			</div>
		</main>
	);
}
