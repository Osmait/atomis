import { useCallback, useRef } from "react";
import type { CreateSessionResponse, Language } from "@atomis/protocol";

import { apiFetch } from "../../shared/api/client.js";
import { WEB_LANGUAGE_PACKS } from "../editor/languagePacks.js";
import {
	loadDefaultTemplate,
	loadScaffold,
} from "../../shared/stores/settings.js";
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
	setStartupError: (message: string | undefined) => void;
	/**
	 * A session open failing during a workspace SWITCH — not the boot. By
	 * then the old socket and language clients are already torn down, but
	 * the rest of the UI is alive; replacing it wholesale with the fatal
	 * boot screen threw away a working editor over a network blip. The
	 * shell shows this recoverably instead.
	 */
	onSwitchFailed: (message: string) => void;
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
		onSwitchFailed,
		setSwitching,
		setCapabilities,
		setStatus,
		setPeek,
		resetToEntry,
		closeRuntime,
		resetRuntime,
		closePicker,
	} = options;

	/**
	 * Whether the last open attempt failed. It keeps the "already there"
	 * shortcut in switchToWorkspace honest: after a failed switch the
	 * session ref still names the OLD workspace, whose socket is gone —
	 * going back to it must be a real reopen, not a no-op.
	 */
	const lastOpenFailedRef = useRef(false);

	const requestSession = useCallback(
		(workspace: string | undefined): Promise<Response> =>
			apiFetch("/api/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					language: loadDefaultTemplate(),
					scaffold: loadScaffold(),
					...(workspace ? { workspace } : {}),
				}),
			}),
		[],
	);

	const openSession = useCallback(
		async (workspace: string | undefined): Promise<void> => {
			// A previous session means this is a switch, not the boot.
			const isSwitch = sessionRef.current !== undefined;
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
				lastOpenFailedRef.current = false;
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
				lastOpenFailedRef.current = true;
				const message =
					error instanceof Error ? error.message : String(error);
				if (isSwitch) onSwitchFailed(message);
				else setStartupError(message);
			} finally {
				setSwitching(false);
			}
		},
		[
			activeLanguageRef,
			entryRef,
			onSwitchFailed,
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
			// started — unless the last open failed, in which case "already
			// there" is a fiction: the session ref still names a workspace
			// whose socket and clients were torn down for the switch.
			if (
				!lastOpenFailedRef.current &&
				id === sessionRef.current?.workspace?.id
			)
				return;
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

	/**
	 * A second try at a failed boot, without the full page reload the error
	 * screen otherwise demands — the server may simply have been slower to
	 * come up than the page.
	 */
	const retryBoot = useCallback((): void => {
		setStartupError(undefined);
		setStatus("Retrying…");
		void openSession(loadActiveWorkspace());
	}, [openSession, setStartupError, setStatus]);

	return { openSession, switchToWorkspace, boot, retryBoot };
}
