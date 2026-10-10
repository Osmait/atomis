import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateSessionResponse } from "@atomis/protocol";
import { EMPTY_DRAFT, sendHttp, type HttpDraft, type HttpExchange } from "./httpClient.js";

/** Requests kept for the history list, newest first. */
const HISTORY = 30;

/**
 * The HTTP view's state: the request being edited, the last answer and the
 * history. Per session — a new session is a new program on a new port, so
 * what was sent to the old one starts over.
 */
export function useHttpPanel(session: CreateSessionResponse | undefined) {
	const [draft, setDraft] = useState<HttpDraft>(EMPTY_DRAFT);
	const [history, setHistory] = useState<HttpExchange[]>([]);
	const [sending, setSending] = useState(false);
	const nextId = useRef(0);

	useEffect(() => {
		setDraft(EMPTY_DRAFT);
		setHistory([]);
		setSending(false);
	}, [session]);

	const send = useCallback(async (): Promise<void> => {
		if (!session) return;
		setSending(true);
		const exchange = await sendHttp(session, draft, ++nextId.current);
		setSending(false);
		setHistory((previous) => [exchange, ...previous].slice(0, HISTORY));
	}, [draft, session]);

	return { draft, setDraft, history, exchange: history[0], sending, send };
}
