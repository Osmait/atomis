import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	use: {
		baseURL: process.env.ATOMIS_BASE_URL ?? "http://127.0.0.1:5173",
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
		command: "pnpm dev",
		url: process.env.ATOMIS_BASE_URL ?? "http://127.0.0.1:5173",
		timeout: 120_000,
		reuseExistingServer: true,
		env: {
			// UI settings live on the server now, so clearing localStorage no
			// longer resets the app: whatever the developer last chose in a
			// real session (Auto Run off, the demo scaffold) would hydrate
			// into every test. Point the run at a file of its own.
			ATOMIS_PREFERENCES: join(tmpdir(), "atomis-e2e-preferences.json"),
			// The suite creates persistent workspaces and does not delete
			// them, so without this every run leaves `spec-<timestamp>`
			// entries in the developer's own switcher.
			ATOMIS_WORKSPACES: join(tmpdir(), "atomis-e2e-workspaces"),
		},
	},
});
