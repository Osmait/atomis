import type { APIRequestContext } from "@playwright/test";

/**
 * Settings live on the server, so `localStorage.clear()` is no longer a clean
 * slate: the shared store would hydrate the previous test's choices — or a
 * real session's, when the suite runs on a developer's machine — back into
 * the next one.
 *
 * Emptying rather than deleting matters. A device that still holds the old
 * values in its own storage uploads them again the moment it finds the
 * server empty, which is how a "reset" quietly undoes itself.
 */
export async function resetPreferences(
	request: APIRequestContext,
	baseURL: string | undefined,
): Promise<void> {
	// The dev server answers before the API behind it is listening, so the
	// first test can arrive to a proxy error. Nothing is stored in that case,
	// which is exactly the state this is trying to reach.
	const response = await request.get("/api/preferences").catch(() => undefined);
	if (!response?.ok()) return;
	const stored = (await response.json().catch(() => ({}))) as {
		preferences?: Record<string, string>;
	};
	const keys = Object.keys(stored.preferences ?? {});
	if (keys.length === 0) return;
	await request.put("/api/preferences", {
		// The guard only ever accepts the UI's own origin.
		headers: { origin: baseURL ?? "http://127.0.0.1:5173" },
		data: { preferences: Object.fromEntries(keys.map((key) => [key, null])) },
	});
}
