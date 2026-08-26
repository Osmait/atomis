import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	use: {
		baseURL: "http://127.0.0.1:5173",
		trace: "retain-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "pnpm dev",
		url: "http://127.0.0.1:5173",
		timeout: 120_000,
		reuseExistingServer: true,
	},
});
