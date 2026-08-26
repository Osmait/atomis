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
import { registerZig } from "./editor/zigLanguage.js";
import { LspClient } from "./lsp/LspClient.js";
import {
	acceptsVersion,
	toggleProbe,
	updateInlineValue,
	type InlineValue,
} from "./state/runtimeState.js";

interface Settings {
	autoRun: boolean;
	autoInspect: boolean;
	debounceMs: number;
	timeoutMs: number;
	manualProbeIds: string[];
}

const DEFAULT_SETTINGS: Settings = {
	autoRun: true,
	autoInspect: true,
	debounceMs: 400,
	timeoutMs: 2000,
	manualProbeIds: [],
};
const SETTINGS_KEY = "ziglive.settings.v1";
const SOURCE_KEY = "ziglive.source.v1";

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
	const [startupError, setStartupError] = useState<string>();
	const [settings, setSettings] = useState<Settings>(loadSettings);
	const [runState, setRunState] = useState<RunState>("idle");
	const [status, setStatus] = useState("Starting…");
	const [catalog, setCatalog] = useState<ProbeDescriptor[]>([]);
	const [values, setValues] = useState<Map<string, InlineValue>>(new Map());
	const [stale, setStale] = useState(false);
	const [output, setOutput] = useState<
		{ stream: "stdout" | "stderr"; chunk: string }[]
	>([]);
	const [diagnostics, setDiagnostics] = useState<
		Record<string, AppDiagnostic[]>
	>({});
	const [result, setResult] = useState<RunResult>();
	const [tab, setTab] = useState<"output" | "problems" | "runtime">("output");
	const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
	const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | undefined>(
		undefined,
	);
	const monacoRef = useRef<Monaco | undefined>(undefined);
	const runtimeRef = useRef<WebSocket | undefined>(undefined);
	const lspRef = useRef<LspClient | undefined>(undefined);
	const decorationsRef = useRef<
		MonacoApi.editor.IEditorDecorationsCollection | undefined
	>(undefined);
	const versionRef = useRef(1);
	const sourceRef = useRef("");
	const settingsRef = useRef(settings);
	const catalogRef = useRef<ProbeDescriptor[]>([]);

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
			.then(setSession)
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

	const handleRuntimeEvent = useCallback((event: RuntimeServerEvent): void => {
		if (
			"documentVersion" in event &&
			!acceptsVersion(versionRef.current, event.documentVersion)
		)
			return;
		if (event.type === "run.state") setRunState(event.state);
		else if (event.type === "probe.catalog") {
			catalogRef.current = event.probes;
			setCatalog(event.probes);
		} else if (event.type === "probe_value") {
			setValues((previous) => updateInlineValue(previous, event));
			setStale(false);
		} else if (event.type === "output")
			setOutput((previous) =>
				[...previous, { stream: event.stream, chunk: event.chunk }].slice(-500),
			);
		else if (event.type === "diagnostics") {
			setDiagnostics((previous) => ({
				...previous,
				[event.owner]: event.diagnostics,
			}));
			const model = editorRef.current?.getModel();
			const monaco = monacoRef.current;
			if (model && monaco)
				monaco.editor.setModelMarkers(
					model,
					event.owner,
					event.diagnostics.map((item) => ({
						message: item.message,
						severity: markerSeverity(monaco, item.severity),
						source: item.source ?? event.owner,
						startLineNumber: item.line,
						startColumn: item.column,
						endLineNumber: item.endLine ?? item.line,
						endColumn: item.endColumn ?? item.column + 1,
					})),
				);
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
			sourceRef.current = model.getValue();
			decorationsRef.current = editor.createDecorationsCollection();

			const runtime = new WebSocket(websocketUrl("/ws/runtime", session));
			runtimeRef.current = runtime;
			runtime.addEventListener("open", () => {
				sendRuntime({
					type: "settings.update",
					sessionId: session.sessionId,
					...settingsRef.current,
				});
				if (sourceRef.current !== session.initialSource) {
					versionRef.current = 2;
					sendRuntime({
						type: "document.update",
						sessionId: session.sessionId,
						version: 2,
						source: sourceRef.current,
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
				(items) => {
					setDiagnostics((previous) => ({
						...previous,
						zls: items.map((item) => ({
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
							source: item.source ?? "zls",
						})),
					}));
				},
				setStatus,
			);
			lspRef.current = lsp;
			lsp.connect(websocketUrl("/ws/lsp", session), versionRef.current);

			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
			editor.addCommand(monaco.KeyCode.Escape, stop);
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
		[handleRuntimeEvent, run, sendRuntime, sendSettings, session, stop],
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
					probe.supported && probe.originalRange.startLine <= lineCount,
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
	}, [catalog, settings.manualProbeIds, stale, values]);

	useEffect(
		() => () => {
			lspRef.current?.dispose();
			runtimeRef.current?.close();
		},
		[],
	);

	const visibleSource = useMemo(
		() => localStorage.getItem(SOURCE_KEY) ?? session?.initialSource ?? "",
		[session],
	);
	const onChange = useCallback(
		(source: string | undefined): void => {
			if (!session || source === undefined || source === sourceRef.current)
				return;
			sourceRef.current = source;
			localStorage.setItem(SOURCE_KEY, source);
			const version = ++versionRef.current;
			setStale(true);
			lspRef.current?.change(version, source);
			sendRuntime({
				type: "document.update",
				sessionId: session.sessionId,
				version,
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
	const allProblems = Object.entries(diagnostics).flatMap(([owner, items]) =>
		items.map((item) => ({ owner, ...item })),
	);
	const busy = ["debouncing", "instrumenting", "compiling", "running"].includes(
		runState,
	);

	return (
		<main className="app-shell">
			<header className="toolbar">
				<strong>ZigLive</strong>
				<button onClick={run} disabled={Boolean(session.degraded.zig)}>
					▶ Run
				</button>
				<button onClick={stop} disabled={!busy}>
					■ Stop
				</button>
				<label>
					<input
						type="checkbox"
						checked={settings.autoRun}
						disabled={Boolean(session.degraded.zig)}
						onChange={(event) =>
							sendSettings({ ...settings, autoRun: event.target.checked })
						}
					/>{" "}
					Auto Run
				</label>
				<label>
					<input
						type="checkbox"
						checked={settings.autoInspect}
						onChange={(event) => {
							sendSettings({ ...settings, autoInspect: event.target.checked });
							setTimeout(run, 0);
						}}
					/>{" "}
					Auto Inspect
				</label>
				<span className={`state state-${runState}`}>{runState}</span>
				<span>
					compile {result ? `${result.compilationMs.toFixed(0)} ms` : "—"}
				</span>
				<span>run {result ? `${result.executionMs.toFixed(0)} ms` : "—"}</span>
				<span>
					Zig {session.zigVersion} · ZLS {session.zlsVersion}
				</span>
			</header>
			<aside className="warning">
				El código se ejecuta localmente con tus permisos. Auto Run está{" "}
				{settings.autoRun ? "activo" : "pausado"}.{" "}
				{Object.values(session.degraded).join(" · ")}
				{Object.keys(session.degraded).length
					? " · Ejecuta pnpm run doctor."
					: ""}
			</aside>
			<section className="editor-wrap">
				<Editor
					height="100%"
					path={session.documentUri}
					defaultLanguage="zig"
					defaultValue={visibleSource}
					theme="vs-dark"
					beforeMount={registerZig}
					onMount={handleMount}
					onChange={onChange}
					options={{
						automaticLayout: true,
						glyphMargin: true,
						minimap: { enabled: false },
						fontSize: 14,
						inlineSuggest: { enabled: true },
					}}
				/>
			</section>
			<section className="bottom-panel">
				<nav>
					<button
						className={tab === "output" ? "active" : ""}
						onClick={() => setTab("output")}
					>
						Output
					</button>
					<button
						className={tab === "problems" ? "active" : ""}
						onClick={() => setTab("problems")}
					>
						Problems ({allProblems.length})
					</button>
					<button
						className={tab === "runtime" ? "active" : ""}
						onClick={() => setTab("runtime")}
					>
						Runtime
					</button>
				</nav>
				<div className="panel-content">
					{tab === "output" && (
						<pre>
							{output.length
								? output.map((entry, index) => (
										<span key={index} className={entry.stream}>
											{entry.chunk}
										</span>
									))
								: "No output yet."}
						</pre>
					)}
					{tab === "problems" && (
						<ul>
							{allProblems.length ? (
								allProblems.map((item, index) => (
									<li key={`${item.owner}-${index}`}>
										<b>{item.owner}</b> · {item.severity} · {item.line}:
										{item.column} — {item.message}
									</li>
								))
							) : (
								<li>No problems.</li>
							)}
						</ul>
					)}
					{tab === "runtime" && (
						<div className="runtime-grid">
							<span>Status</span>
							<b>{runState}</b>
							<span>Exit code</span>
							<b>{result?.exitCode ?? "—"}</b>
							<span>Signal</span>
							<b>{result?.signal ?? "—"}</b>
							<span>Timeout</span>
							<b>{result?.timedOut ? "yes" : "no"}</b>
							<span>Probes / values</span>
							<b>
								{catalog.length} / {values.size}
							</b>
							<span>ZLS capabilities</span>
							<b>
								{Object.keys(capabilities)
									.filter((key) => capabilities[key])
									.join(", ") || status}
							</b>
						</div>
					)}
				</div>
			</section>
		</main>
	);
}
