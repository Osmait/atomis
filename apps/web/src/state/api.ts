/**
 * Talking to the Atomis server.
 *
 * When the server runs with ATOMIS_TOKEN set, every call has to carry that
 * secret. The page receives it once as `?t=…` — the only way a link can hand
 * it over — and keeps it per device, which is why it is deliberately not one
 * of the preferences that sync.
 *
 * With no token configured the header is simply absent and nothing changes.
 */

const TOKEN_KEY = "atomis.access-token.v1";

/**
 * Takes the token out of the address bar and remembers it, so a reload or a
 * bookmark still works and the secret stops being on screen. Call once,
 * before anything else talks to the server.
 */
export function captureAccessToken(): void {
	let url: URL;
	try {
		url = new URL(window.location.href);
	} catch {
		return;
	}
	const token = url.searchParams.get("t");
	if (!token) return;
	try {
		localStorage.setItem(TOKEN_KEY, token);
	} catch {
		// Storage blocked: the token lives for this page load only.
	}
	url.searchParams.delete("t");
	window.history.replaceState({}, "", url.toString());
}

export function accessToken(): string | undefined {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

/** fetch, with the access token attached when there is one. */
export function apiFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const token = accessToken();
	return fetch(path, {
		...init,
		headers: {
			...init.headers,
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
}
