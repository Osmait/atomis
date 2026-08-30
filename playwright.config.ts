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
		...devices["Desktop Chrome"],
	},
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
		},
	},
});
