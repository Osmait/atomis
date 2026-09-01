import type { FullConfig } from "@playwright/test";

/**
 * Fails the whole run before a single test touches the server, when the
 * server it would touch does not have isolated preferences. Playwright
 * starts the webServer before globalSetup, so by the time this runs a
 * healthy stack answers /api/health — and with `reuseExistingServer: true`
 * that stack can be one this config did NOT start.
 *
 * A connection error is not a verdict: the API may still be warming up
 * behind the Vite proxy. The per-test guard in reset.ts re-asks before the
 * first destructive call, so nothing runs unguarded either way.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
	const healthURL = config.webServer?.url;
	if (!healthURL) return;
	let body: { isolatedPreferences?: boolean };
	try {
		const response = await fetch(healthURL);
		if (!response.ok) return;
		body = (await response.json()) as typeof body;
	} catch {
		return;
	}
	if (body.isolatedPreferences !== true) {
		throw new Error(
			"Refusing to run e2e against a server whose preferences are not isolated " +
				"(set ATOMIS_PREFERENCES). Is the real Atomis running on this port?",
		);
	}
}
