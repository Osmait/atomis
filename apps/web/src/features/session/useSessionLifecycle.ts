import { useCallback, useRef } from "react";
import type { CreateSessionResponse, Language } from "@atomis/protocol";

import { apiFetch } from "../../shared/api/client.js";
import { WEB_LANGUAGE_PACKS } from "../editor/languagePacks.js";
import { loadLanguage, loadScaffold } from "../../shared/stores/settings.js";
import {
	loadActiveWorkspace,
	saveActiveWorkspace,
} from "../../shared/stores/workspaces.js";
import type { LspClient } from "../editor/lsp/LspClient.js";
import type { ProjectFile } from "../../shared/types.js";
import type { Settings } from "../../shared/stores/settings.js";

interface SessionLifecycleOptions {
	/** The session everything else hangs off; the shell owns it. */
	sessionRef: React.RefObject<CreateSessionResponse | undefined>;
	setSession: (session: CreateSessionResponse) => void;
	entryRef: React.RefObject<string>;
	activeLanguageRef: React.RefObject<Language>;
	versionRef: React.RefObject<number>;
	settingsRef: React.RefObject<Settings>;
	lspClientsRef: React.RefObject<Partial<Record<Language, LspClient>>>;
	setProjectFiles: (files: ProjectFile[]) => void;
	setSettings: (update: (previous: Settings) => Settings) => void;
	setStartupError: (message: string) => void;
	setSwitching: (switching: boolean) => void;
	setCapabilities: (capabilities: Record<string, never>) => void;
	setStatus: (status: string) => void;
	setPeek: (peek: null) => void;
	resetToEntry: (entry: string) => void;
	closeRuntime: () => void;
	resetRuntime: () => void;
	closePicker: () => void;
}

/**
 * Opening a session, and swapping the one underneath the window.
 *
 * This is the only place that can do either, because it is the only place
 * that holds all of what a session owns: the socket, the language clients,
 * the models and the file list. That is why it takes so many collaborators
 * — the orchestration is the thing being named here, not hidden.
 */
export function useSessionLifecycle(options: SessionLifecycleOptions) {
	const {
		sessionRef,
		setSession,
		entryRef,
		activeLanguageRef,
		versionRef,
		settingsRef,
		lspClientsRef,
		setProjectFiles,
		setSettings,
		setStartupError,
		setSwitching,
		setCapabilities,
		setStatus,
		setPeek,
		resetToEntry,
		closeRuntime,
		resetRuntime,
		closePicker,
	} = options;

	const requestSession = useCallback(
		(workspace: string | undefined): Promise<Response> =>
			apiFetch("/api/sessions", {
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
				setProjectFiles(projectFiles);
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
		[
			activeLanguageRef,
			entryRef,
			requestSession,
			resetToEntry,
			sessionRef,
			setProjectFiles,
			setSession,
			setSettings,
			setStartupError,
			setSwitching,
			settingsRef,
		],
	);

	const switchToWorkspace = useCallback(
		(id: string | undefined): void => {
			closePicker();
			// Re-opening the workspace you are already in would throw away a
			// live session (and flash the tree) to arrive exactly where you
			// started.
			if (id === sessionRef.current?.workspace?.id) return;
			saveActiveWorkspace(id);
			setSwitching(true);
			for (const client of Object.values(lspClientsRef.current))
				client?.dispose();
			lspClientsRef.current = {};
			closeRuntime();
			resetRuntime();
			setCapabilities({});
			setPeek(null);
			setStatus("Opening workspace…");
			versionRef.current = 1;
			void openSession(id);
		},
		[
			closePicker,
			closeRuntime,
			lspClientsRef,
			openSession,
			resetRuntime,
			sessionRef,
			setCapabilities,
			setPeek,
			setStatus,
			setSwitching,
			versionRef,
		],
	);
	/** Boots once, into whatever workspace was last open. */
	const bootedRef = useRef(false);
	const boot = useCallback((): void => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		void openSession(loadActiveWorkspace());
	}, [openSession]);

	return { openSession, switchToWorkspace, boot };
}
