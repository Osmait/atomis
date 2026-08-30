import { useCallback, useEffect, useRef, useState } from "react";
import type {
	CreateSessionResponse,
	Language,
	RuntimeServerEvent,
} from "@atomis/protocol";
import type { LspClient } from "../editor/lsp/LspClient.js";
import { websocketUrl } from "../../shared/api/client.js";
import type { ProjectFilesReader } from "../../shared/types.js";
import type { Settings } from "../../shared/stores/settings.js";

/** Longest gap between reconnection attempts. */
const MAX_RETRY_MS = 10_000;

interface RuntimeSocketOptions {
	session: CreateSessionResponse | undefined;
	handleRuntimeEvent: (event: RuntimeServerEvent) => void;
	settingsRef: React.RefObject<Settings>;
	filesRef: ProjectFilesReader;
	entryRef: React.RefObject<string>;
	versionRef: React.RefObject<number>;
	lspClientsRef: React.RefObject<Partial<Record<Language, LspClient>>>;
	setStatus: (status: string) => void;
}

/**
 * The session's runtime channel, and getting it back when it drops.
 *
 * A tablet drops this socket every time its screen locks, so losing it is
 * ordinary rather than exceptional: the effect re-runs on `reconnect`, each
 * attempt waiting a little longer, and the language clients are disposed on
 * the way down because the servers behind them went with the session's
 * socket and the cached ones would be talking to nothing.
 */
export function useRuntimeSocket(options: RuntimeSocketOptions) {
	const {
		session,
		handleRuntimeEvent,
		settingsRef,
		filesRef,
		entryRef,
		versionRef,
		lspClientsRef,
		setStatus,
	} = options;
	const runtimeRef = useRef<WebSocket | undefined>(undefined);
	const [reconnect, setReconnect] = useState(0);
	const retryRef = useRef(0);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	const sendRuntime = useCallback((message: object): void => {
		if (runtimeRef.current?.readyState === WebSocket.OPEN)
			runtimeRef.current.send(JSON.stringify(message));
	}, []);

	useEffect(() => {
		if (!session) return;
		const socket = new WebSocket(websocketUrl("/ws/runtime", session));
		runtimeRef.current = socket;
		socket.addEventListener("open", () => {
			const reattached = retryRef.current > 0;
			retryRef.current = 0;
			if (reattached) setStatus("Runtime reconnected");
			sendRuntime({
				type: "settings.update",
				sessionId: session.sessionId,
				...settingsRef.current,
			});
			const mainSource =
				filesRef.current.find((file) => file.path === entryRef.current)
					?.source ?? session.initialSource;
			// On a first connect the server is at version 1 with the initial
			// source; on a reattach it may have missed edits made while the
			// socket was down, so push what is on screen either way. The
			// version only ever moves forward, so the server accepts it.
			if (reattached || mainSource !== session.initialSource) {
				const version = Math.max(versionRef.current + 1, 2);
				versionRef.current = version;
				sendRuntime({
					type: "document.update",
					sessionId: session.sessionId,
					version,
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
		socket.addEventListener("close", () => {
			// Only the socket this effect still owns may schedule a retry: one
			// closed by the cleanup below belongs to a session we have left.
			if (runtimeRef.current !== socket) return;
			runtimeRef.current = undefined;
			// The language servers went down with the session's socket, so the
			// cached clients are talking to nothing. Drop them; ensureLspClient
			// builds new ones once we are back.
			for (const client of Object.values(lspClientsRef.current))
				client?.dispose();
			lspClientsRef.current = {};

			const attempt = (retryRef.current += 1);
			const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_MS);
			setStatus(
				`Runtime disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})`,
			);
			retryTimerRef.current = setTimeout(
				() => setReconnect((previous) => previous + 1),
				delay,
			);
		});
		return () => {
			// Closing here stops the old session's events from reaching the
			// new one; the server tears its side down on disconnect.
			if (runtimeRef.current === socket) runtimeRef.current = undefined;
			socket.close();
			if (retryTimerRef.current !== undefined)
				clearTimeout(retryTimerRef.current);
		};
	}, [
		entryRef,
		filesRef,
		handleRuntimeEvent,
		lspClientsRef,
		reconnect,
		sendRuntime,
		session,
		setStatus,
		settingsRef,
		versionRef,
	]);

	/**
	 * Drops the current connection. Used when the session underneath is
	 * being replaced, so its events cannot reach the one that follows.
	 */
	const closeRuntime = useCallback((): void => {
		runtimeRef.current?.close();
	}, []);

	return { sendRuntime, closeRuntime };
}
