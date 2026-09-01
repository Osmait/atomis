import { expect, test } from "@playwright/test";
import { resetPreferences } from "./reset.js";

test.beforeEach(async ({ request, baseURL }) => {
	await resetPreferences(request, baseURL);
});

/**
 * Preferences live on the server so every device agrees with itself — and
 * agreeing must not require a reload: a change is pushed over the runtime
 * WebSocket (`preferences.changed`) to every open tab. Two independent
 * browser contexts stand in for the laptop and the iPad.
 */
test("a theme picked on one device reaches another without a reload", async ({
	browser,
	baseURL,
}) => {
	const deviceA = await browser.newContext();
	const deviceB = await browser.newContext();
	try {
		const pageA = await deviceA.newPage();
		const pageB = await deviceB.newPage();
		await pageA.goto(`${baseURL}/`);
		await expect(pageA.locator(".file-tree")).toBeVisible();
		await pageB.goto(`${baseURL}/`);
		await expect(pageB.locator(".file-tree")).toBeVisible();

		// Both start on the default theme after the reset.
		await expect(pageA.locator(".app-shell")).toHaveAttribute(
			"data-theme",
			"mocha",
		);
		await expect(pageB.locator(".app-shell")).toHaveAttribute(
			"data-theme",
			"mocha",
		);

		// A marker on B's window: if the theme ever arrived via a reload
		// instead of the push, this probe would be wiped with the page.
		await pageB.evaluate(() => {
			(window as object as { atomisSyncProbe?: number }).atomisSyncProbe = 9;
		});

		// Device A picks a theme in Settings → Appearance.
		await pageA.locator(".chrome-icon").click();
		await pageA.locator(".settings-tab", { hasText: "Appearance" }).click();
		await pageA.locator(".theme-card", { hasText: "Nord" }).click();
		await expect(pageA.locator(".app-shell")).toHaveAttribute(
			"data-theme",
			"nord",
		);

		// Device B repaints from the WebSocket push, no reload involved.
		await expect(pageB.locator(".app-shell")).toHaveAttribute(
			"data-theme",
			"nord",
		);
		expect(
			await pageB.evaluate(
				() =>
					(window as object as { atomisSyncProbe?: number }).atomisSyncProbe,
			),
		).toBe(9);
	} finally {
		await deviceA.close();
		await deviceB.close();
	}
});
