import { accessToken } from "../../shared/api/client.js";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A request as the panel edits it. */
export interface HttpDraft {
	method: HttpMethod;
	path: string;
	/** "Name: value" per line. */
	headers: string;
	body: string;
}

export interface HttpExchange {
	id: number;
	request: HttpDraft;
	at: number;
	ms: number;
	status?: number;
	statusText?: string;
	headers: [string, string][];
	body: string;
	bytes: number;
	/** Atomis could not get an answer: nothing listening, a timeout. */
	error?: string;
}

/** Shown in full up to this much; the rest is counted, not rendered. */
const BODY_PREVIEW_CHARS = 200_000;

export const EMPTY_DRAFT: HttpDraft = { method: "GET", path: "/", headers: "", body: "" };

/** `"/items"` from what was typed: `items`, `/items`, a full URL's path. */
export function normalizePath(path: string): string {
	const trimmed = path.trim();
	try {
		const url = new URL(trimmed);
		return `${url.pathname}${url.search}`;
	} catch {
		return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	}
}

/** "Name: value" lines; anything else is skipped rather than guessed at. */
export function parseHeaderLines(text: string): [string, string][] {
	return text.split("\n").flatMap((line): [string, string][] => {
		const colon = line.indexOf(":");
		if (colon <= 0) return [];
		const name = line.slice(0, colon).trim();
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return [];
		return [[name, line.slice(colon + 1).trim()]];
	});
}

/** JSON re-indented; anything else as it came. */
export function prettyBody(body: string, contentType: string | undefined): string {
	const looksJson = contentType?.includes("json") || /^\s*[[{]/.test(body);
	if (!looksJson) return body;
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

/**
 * Sends `draft` to the session's program through the Atomis proxy.
 *
 * Atomis's credentials go in its own headers, never `Authorization`: that
 * one is the program's, for whatever auth it is practising.
 */
export async function sendHttp(
	session: { sessionId: string; authToken: string },
	draft: HttpDraft,
	id: number,
	fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<HttpExchange> {
	const started = performance.now();
	const at = Date.now();
	const headers = new Headers();
	for (const [name, value] of parseHeaderLines(draft.headers)) headers.append(name, value);
	headers.set("x-atomis-session", session.authToken);
	const token = accessToken();
	if (token) headers.set("x-atomis-token", token);
	const hasBody = draft.method !== "GET" && draft.body !== "";
	if (hasBody && !headers.has("content-type"))
		headers.set("content-type", /^\s*[[{]/.test(draft.body) ? "application/json" : "text/plain");
	const request = { ...draft, path: normalizePath(draft.path) };
	try {
		const response = await fetcher(`/api/sessions/${session.sessionId}/http${request.path}`, {
			method: draft.method,
			headers,
			...(hasBody ? { body: draft.body } : {}),
		});
		const text = await response.text();
		const ms = Math.round(performance.now() - started);
		const responseHeaders = [...response.headers.entries()];
		if (response.headers.get("x-atomis-proxy-error")) {
			let error = text;
			try {
				error = (JSON.parse(text) as { error?: string }).error ?? text;
			} catch {
				// Not JSON: the text is the message.
			}
			return { id, request, at, ms, headers: responseHeaders, body: "", bytes: 0, error };
		}
		return {
			id,
			request,
			at,
			ms,
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
			body: prettyBody(text.slice(0, BODY_PREVIEW_CHARS), response.headers.get("content-type") ?? undefined),
			bytes: new TextEncoder().encode(text).length,
		};
	} catch (failure) {
		const ms = Math.round(performance.now() - started);
		return {
			id,
			request,
			at,
			ms,
			headers: [],
			body: "",
			bytes: 0,
			error: failure instanceof Error ? failure.message : String(failure),
		};
	}
}
