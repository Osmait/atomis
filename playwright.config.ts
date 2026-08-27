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
	},
});
