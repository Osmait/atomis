import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/*
 * The e2e stack listens on ports of its own — 4391 for the Rust server,
 * 5391 for Vite — so the suite can run on a machine where the real Atomis
 * (4317) and a dev Vite (5173) are already up, without ever touching them.
 * ATOMIS_PORT / ATOMIS_WEB_PORT / ATOMIS_BASE_URL still override.
 */
const apiPort = process.env.ATOMIS_PORT ?? "4391";
const webPort = process.env.ATOMIS_WEB_PORT ?? "5391";
const baseURL = process.env.ATOMIS_BASE_URL ?? `http://127.0.0.1:${webPort}`;

/*
 * Every run gets a data directory of its own (pid + timestamp), deleted by
 * globalTeardown. A fixed path shared between runs meant preferences and
 * `spec-<timestamp>` workspaces accumulated forever in the OS tmpdir.
 * Workers re-evaluate this file and would compute a different name, but
 * only the main process uses it: webServer.env and the teardown both live
 * there, and the teardown reads the name back from config.webServer.env.
 */
const dataDir = join(tmpdir(), `atomis-e2e-${process.pid}-${Date.now()}`);

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	globalSetup: "./tests/e2e/global-setup.ts",
	globalTeardown: "./tests/e2e/global-teardown.ts",
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	/*
	 * The main suite is a desktop with a mouse. touch.spec runs the same app
	 * at the sizes it is actually opened on — a menu that only misbehaves
	 * when the terminal is docked below, which narrow screens force, reached
	 * an iPad because nothing here had ever been narrow.
	 */
	projects: [
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"] },
			testIgnore: "**/touch.spec.ts",
		},
		/*
		 * Chromium, not the WebKit these device profiles default to: the
		 * repo installs one browser on purpose. What is under test here is
		 * size and touch — clipping, hit areas, what a tap lands on — and
		 * those do not turn on the engine. Real iOS rendering is still only
		 * checked by opening it on the iPad.
		 */
		{
			name: "phone",
			use: { ...devices["iPhone 13"], browserName: "chromium" },
			testMatch: "**/touch.spec.ts",
		},
		{
			name: "tablet",
			use: { ...devices["iPad (gen 7)"], browserName: "chromium" },
			testMatch: "**/touch.spec.ts",
		},
	],
	webServer: {
		// dev:e2e, not dev: the web package's dev script pins `--port 5173`
		// on the CLI, which beats vite.config.ts — the e2e variant passes
		// this stack's own port instead (see package.json).
		command: "pnpm dev:e2e",
		// Through the proxy to the API, not just the web port: `pnpm dev`
		// starts Vite and the Rust server side by side, and Vite answers
		// first. Waiting only on it let the first test of a run open a page
		// whose session could not be created — a failure that looked like a
		// missing file tree and passed on its own every time.
		url: `${baseURL}/api/health`,
		timeout: 120_000,
		// Reuse is safe now on two counts: these ports are the e2e stack's
		// own, and the isolatedPreferences guard (global-setup.ts + reset.ts)
		// refuses any server that was not started with ATOMIS_PREFERENCES.
		reuseExistingServer: true,
		env: {
			// The Rust server binds here, and Vite's /api proxy follows the
			// same variable (apps/web/vite.config.ts).
			ATOMIS_PORT: apiPort,
			ATOMIS_WEB_PORT: webPort,
			// The server's Origin guard only knows its own loopback origin
			// and Vite's default 5173; a parallel harness announces its page
			// origin through this allowlist (see apps/server-rs/src/util.rs).
			ATOMIS_DEV_ORIGIN: baseURL,
			// UI settings live on the server now, so clearing localStorage no
			// longer resets the app: whatever the developer last chose in a
			// real session (Auto Run off, the demo scaffold) would hydrate
			// into every test. Point the run at a file of its own.
			ATOMIS_PREFERENCES: join(dataDir, "preferences.json"),
			// The suite creates persistent workspaces; a per-run directory
			// (cleaned in globalTeardown) keeps `spec-<timestamp>` entries
			// out of the developer's own switcher and off the disk.
			ATOMIS_WORKSPACES: join(dataDir, "workspaces"),
		},
	},
});
