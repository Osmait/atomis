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

/**
 * The anti-disaster guard. This reset wipes every preference on whatever
 * server the suite is pointed at, and with `reuseExistingServer: true` that
 * server can be the developer's real Atomis — whose preferences sync to
 * every device they own. `/api/health` exposes `isolatedPreferences`
 * (true only when the server was started with ATOMIS_PREFERENCES), so ask
 * before touching anything and refuse the whole suite if the answer is no.
 *
 * Cached per base URL: the suite runs against one server, and a check that
 * passed once cannot un-pass while that server is alive.
 */
const verifiedIsolated = new Set<string>();

async function assertIsolatedPreferences(
	request: APIRequestContext,
	baseURL: string | undefined,
): Promise<boolean> {
	const key = baseURL ?? "";
	if (verifiedIsolated.has(key)) return true;
	const health = await request.get("/api/health").catch(() => undefined);
	// No server yet (the dev server answers before the API behind it): there
	// is nothing to wipe, so there is nothing to guard. Do not cache — the
	// next test must ask again once the API is up.
	if (!health?.ok()) return false;
	const body = (await health.json().catch(() => ({}))) as {
		isolatedPreferences?: boolean;
	};
	if (body.isolatedPreferences !== true) {
		throw new Error(
			"Refusing to run e2e against a server whose preferences are not isolated " +
				"(set ATOMIS_PREFERENCES). Is the real Atomis running on this port?",
		);
	}
	verifiedIsolated.add(key);
	return true;
}

export async function resetPreferences(
	request: APIRequestContext,
	baseURL: string | undefined,
): Promise<void> {
	if (!(await assertIsolatedPreferences(request, baseURL))) return;
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
		headers: { origin: baseURL ?? "http://127.0.0.1:5391" },
		data: { preferences: Object.fromEntries(keys.map((key) => [key, null])) },
	});
}
