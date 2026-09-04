import { expect, test } from "@playwright/test";
import { resetPreferences } from "./reset.js";

test.beforeEach(async ({ request, baseURL }) => {
	await resetPreferences(request, baseURL);
});

test("the chosen default survives file browsing and creates Rust workspaces", async ({
	page,
}) => {
	test.slow();
	await page.goto("/");
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();

	await page.locator(".chrome-icon").click();
	await page.getByRole("tab", { name: "Editor" }).click();
	const templates = page.getByRole("group", { name: "Default template" });
	await expect(templates.getByRole("button")).toHaveCount(7);
	await templates.getByTitle("Start new workspaces with Rust").click();
	await expect(
		templates.getByTitle("Start new workspaces with Rust"),
	).toHaveAttribute("aria-pressed", "true");
	await page
		.getByRole("dialog", { name: "Settings" })
		.getByTitle("Close")
		.click();

	// Browsing another language used to overwrite the stored preference.
	await page.getByRole("button", { name: "main.go", exact: true }).click();
	await expect(page.locator(".global-status")).toContainText("src/main.go");
	await page.reload();
	await expect(page.locator(".global-status")).toContainText("src/main.rs", {
		timeout: 30_000,
	});

	await page.locator(".workspace-bar").click();
	const input = page.getByLabel("New workspace name");
	await expect(input).toHaveAttribute(
		"placeholder",
		"name a new Rust workspace…",
	);
	const name = `rust-default-${Date.now()}`;
	await input.fill(name);
	await page.getByRole("button", { name: "create" }).click();
	await expect(page.locator(".workspace-bar")).toContainText(name, {
		timeout: 30_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.rs");

	page.once("dialog", (dialog) => dialog.accept());
	await page.locator(".workspace-bar").click();
	await page.getByLabel(`Delete ${name}`).click();
});
