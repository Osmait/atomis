import { useCallback, useEffect, useRef, useState } from "react";
import {
	MAX_SOURCE_BYTES,
	type CreateSessionResponse,
	type Language,
	type RuntimeServerEvent,
} from "@atomis/protocol";
import type { LspClient } from "../editor/lsp/LspClient.js";
import { websocketUrl } from "../../shared/api/client.js";
import type { ProjectFilesReader } from "../../shared/types.js";
import type { Settings } from "../../shared/stores/settings.js";

/** Longest gap between reconnection attempts. */
const MAX_RETRY_MS = 10_000;

/**
 * Messages worth keeping while the socket is away. Edits and file
 * operations are the user's work: dropped, the server compiles stale code
 * after a reconnect and a file created offline "does not exist". Runs and
 * cancels are moments, not state — replaying them would be wrong.
 */
const QUEUEABLE = new Set([
	"document.update",
	"file.create",
	"file.rename",
	"file.delete",
]);
const QUEUE_LIMIT = 256;

interface QueuedMessage {
	type?: string;
	path?: string;
	source?: string;
}

interface RuntimeSocketOptions {
	session: CreateSessionResponse | undefined;
	handleRuntimeEvent: (event: RuntimeServerEvent) => void;
	settingsRef: React.RefObject<Settings>;
	filesRef: ProjectFilesReader;
	entryRef: React.RefObject<string>;
	versionRef: React.RefObject<number>;
	/** The shared-workspace revision our next write is built on, if any. */
	revisionRef: React.RefObject<number | undefined>;
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
		revisionRef,
		lspClientsRef,
		setStatus,
	} = options;
	const runtimeRef = useRef<WebSocket | undefined>(undefined);
	const [reconnect, setReconnect] = useState(0);
	const retryRef = useRef(0);
	const pendingRef = useRef<QueuedMessage[]>([]);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	// A new session starts from nothing: pending traffic and backoff state
	// belong to the one being left behind.
	useEffect(() => {
		retryRef.current = 0;
		pendingRef.current = [];
	}, [session]);

	const sendRuntime = useCallback(
		(message: object): void => {
			const typed = message as QueuedMessage;
			if (typed.type === "document.update") {
				const source = typed.source ?? "";
				// The server closes the socket outright past its frame limit,
				// and the reconnect would push the same oversized source
				// again: a silent forever-loop. Refuse here, visibly.
				if (
					source.length > MAX_SOURCE_BYTES / 3 &&
					new TextEncoder().encode(source).length > MAX_SOURCE_BYTES
				) {
					setStatus(
						"File exceeds 1 MiB — edits stay local until it shrinks",
					);
					return;
				}
			}
			const socket = runtimeRef.current;
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
				return;
			}
			// Away (screen lock, restart mid-flight): edits and file
			// operations queue and replay on reattach, in order, with the
			// versions and base revisions they were built with — a stale
			// base surfaces as a conflict instead of a silent overwrite.
			if (!QUEUEABLE.has(typed.type ?? "")) return;
			const pending = pendingRef.current;
			if (typed.type === "document.update") {
				const index = pending.findIndex(
					(queued) =>
						queued.type === "document.update" && queued.path === typed.path,
				);
				if (index >= 0) {
					pending[index] = typed;
					return;
				}
			}
			if (pending.length >= QUEUE_LIMIT) {
				setStatus("Offline queue full — oldest offline edit dropped");
				pending.shift();
			}
			pending.push(typed);
		},
		[setStatus],
	);

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
			// Everything that happened while the socket was away, in order:
			// creates before the edits that need them, versions ascending.
			const pending = pendingRef.current;
			pendingRef.current = [];
			for (const queued of pending) socket.send(JSON.stringify(queued));
			const entryQueued = pending.some(
				(queued) =>
					queued.type === "document.update" &&
					queued.path === entryRef.current,
			);
			const mainSource =
				filesRef.current.find((file) => file.path === entryRef.current)
					?.source ?? session.initialSource;
			// On a first connect the server is at version 1 with the initial
			// source; on a reattach it may have missed edits made while the
			// socket was down, so push what is on screen unless the queue
			// already carried it. The version only moves forward, and the
			// base revision comes along so a shared workspace can refuse a
			// write built on what a peer has since replaced — losing THEIR
			// work silently is exactly what the revisions exist to prevent.
			if (!entryQueued && (reattached || mainSource !== session.initialSource)) {
				const version = Math.max(versionRef.current + 1, 2);
				versionRef.current = version;
				sendRuntime({
					type: "document.update",
					sessionId: session.sessionId,
					version,
					path: entryRef.current,
					source: mainSource,
					...(revisionRef.current === undefined
						? {}
						: { baseRevision: revisionRef.current }),
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
		revisionRef,
		sendRuntime,
		session,
		setStatus,
		settingsRef,
		versionRef,
	]);

	/**
	 * Drops the current connection. Used when the session underneath is
	 * being replaced, so its events cannot reach the one that follows.
	 * Disowning the socket FIRST matters: the close handler treats a socket
	 * it still owns as a crash, announces "reconnecting", and a retry
	 * landing after the switch would reattach to the session being left —
	 * pushing the old workspace's content into the new session's document.
	 */
	const closeRuntime = useCallback((): void => {
		const socket = runtimeRef.current;
		runtimeRef.current = undefined;
		retryRef.current = 0;
		pendingRef.current = [];
		if (retryTimerRef.current !== undefined) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = undefined;
		}
		socket?.close();
	}, []);

	return { sendRuntime, closeRuntime };
}
