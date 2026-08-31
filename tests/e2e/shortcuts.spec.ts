import { expect, test } from "@playwright/test";
import { openClean, replaceEditor, setToggle } from "./helpers.js";
import { resetPreferences } from "./reset.js";

test.beforeEach(async ({ request, baseURL }) => {
	await resetPreferences(request, baseURL);
});

test("Ctrl/Cmd+Enter runs the program by hand", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();

	// With Auto Run off an edit parks the session in idle — the state the
	// shortcut exists for.
	await setToggle(page, "Auto Run", false);
	await replaceEditor(
		page,
		"pub fn main() void {\n    const answer: i32 = 7;\n    _ = answer;\n}\n",
	);
	await expect(page.locator(".state-idle")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.getByText("7 : i32", { exact: true })).toBeVisible();
});

test("the palette creates a file from a typed name", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+K");
	const palette = page.locator(".palette");
	await expect(palette).toBeVisible();

	// A name no existing file matches leaves exactly one row: create it.
	const name = "desde-palette.zig";
	await palette.getByLabel("Find file").fill(name);
	const createRow = palette.locator(".palette-row", {
		hasText: `create ${name}`,
	});
	await expect(createRow).toBeVisible();
	await page.keyboard.press("Enter");

	// The palette closes and the new file is created, opened and listed.
	await expect(palette).toHaveCount(0);
	await expect(page.locator(".global-status")).toContainText(`src/${name}`);
	await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
});
