import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The handful of page helpers the auxiliary specs share, mirroring the ones
 * atomis.spec.ts defines for itself. Deliberately a copy rather than an
 * extraction: the main spec is long and battle-tested, and rewiring its
 * internals to import from here would churn far more than these few lines.
 */

/** The tabs the settings dialog groups its behaviour toggles into. */
const SETTINGS_TABS = ["Run", "Editor", "Appearance"] as const;

/**
 * Finds a behaviour toggle in an already-open dialog, selecting whichever
 * tab holds it.
 */
export async function findToggle(page: Page, label: string) {
	const toggle = page.locator(".settings-toggle").filter({
		has: page.getByText(label, { exact: true }),
	});
	for (const tab of SETTINGS_TABS) {
		await page.locator(".settings-tab", { hasText: tab }).click();
		if ((await toggle.count()) > 0) return toggle;
	}
	throw new Error(`No settings toggle labelled ${label} on any tab`);
}

/** Opens the settings modal (gear), flips a behaviour toggle if needed. */
export async function setToggle(
	page: Page,
	label: string,
	on: boolean,
): Promise<void> {
	await page.locator(".chrome-icon").click();
	const toggle = await findToggle(page, label);
	await expect(toggle).toBeVisible();
	const isOn = await toggle
		.locator(".switch")
		.evaluate((element) => element.classList.contains("on"));
	if (isOn !== on) await toggle.click();
	await page.keyboard.press("Escape");
	await expect(page.locator(".settings-modal")).toHaveCount(0);
}

export async function openClean(page: Page): Promise<void> {
	await page.goto("/");
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
}

export async function replaceEditor(page: Page, source: string): Promise<void> {
	// Paste instead of typing: Monaco applies auto-indent and brace
	// auto-closing to typed text, which corrupts multi-line snippets whose
	// first line opens a block. Paste inserts the text verbatim. The page is
	// already navigated here, so its own URL is the right clipboard origin.
	await page
		.context()
		.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: new URL(page.url()).origin,
		});
	await page.evaluate(
		async (text) => await navigator.clipboard.writeText(text),
		source,
	);
	await page.getByRole("textbox", { name: "Editor content" }).focus();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("ControlOrMeta+V");
}

/** The doctor gate every language-dependent spec uses. */
export async function doctorAvailable(
	page: Page,
	checkName: string,
): Promise<boolean> {
	return await page.evaluate(async (name) => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return body.checks.some(
			(check) => check.name === name && !check.detected.includes("degraded"),
		);
	}, checkName);
}
