import { useCallback, useEffect, useRef, useState } from "react";
import {
	MAX_INPUT_BYTES,
	type CreateSessionResponse,
	type RuntimeClientMessage,
} from "@atomis/protocol";

/** Typing pauses this long before the text goes to the server. */
const SEND_DELAY_MS = 300;

export function inputBytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * The Input text: what the program reads on stdin, on every run.
 *
 * The server holds it per session (and keeps it with a persistent
 * workspace), so it starts from the session's own. Edits go out once typing
 * pauses — each one is a new run under Auto Run, like an edit to the code —
 * and `flush` sends a pending one at once, so a run asked for right after
 * typing reads what was typed.
 */
export function useRunInput(
	session: CreateSessionResponse | undefined,
	sendRuntime: (message: RuntimeClientMessage) => void,
) {
	const [input, setInputState] = useState(session?.input ?? "");
	const pendingRef = useRef<string | undefined>(undefined);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	// A new session (a workspace switch, a recovery) brings its own input.
	// Anything still pending belonged to the old one: sending it would carry
	// a sessionId the server no longer knows, and it closes the socket.
	useEffect(() => {
		clearTimeout(timerRef.current);
		pendingRef.current = undefined;
		setInputState(session?.input ?? "");
	}, [session]);
	useEffect(() => () => clearTimeout(timerRef.current), []);

	const flush = useCallback((): void => {
		clearTimeout(timerRef.current);
		const text = pendingRef.current;
		pendingRef.current = undefined;
		if (text === undefined || !session) return;
		// Over the limit stays local: the panel says so, and the server
		// keeps the last input that fit.
		if (inputBytes(text) > MAX_INPUT_BYTES) return;
		sendRuntime({ type: "input.update", sessionId: session.sessionId, text });
	}, [sendRuntime, session]);

	const setInput = useCallback(
		(text: string): void => {
			setInputState(text);
			pendingRef.current = text;
			clearTimeout(timerRef.current);
			timerRef.current = setTimeout(flush, SEND_DELAY_MS);
		},
		[flush],
	);

	return { input, setInput, flushInput: flush };
}
