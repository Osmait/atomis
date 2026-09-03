import { expect, test } from "@playwright/test";
import { resetPreferences } from "./reset.js";

/**
 * The phone and tablet suite.
 *
 * Everything else runs at desktop size with a mouse, which is how a menu
 * that only breaks when the terminal is docked below — the dock narrow
 * screens force — reached a real iPad unnoticed. These run at the sizes
 * people actually open Atomis on, with touch.
 */

test.beforeEach(async ({ request, baseURL }) => {
	await resetPreferences(request, baseURL);
});

async function openReady(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	await expect(page.locator(".state-succeeded")).toBeVisible();
}

test("the essential controls are on screen at this size", async ({ page }) => {
	await openReady(page);
	// Without these there is no way to run anything by hand, which is what
	// having no keyboard makes essential rather than convenient.
	await expect(page.locator(".editor-chrome")).toBeVisible();
	await expect(
		page.getByRole("toolbar", { name: "Mobile editor controls" }),
	).toBeVisible();
	await expect(page.locator(".run-button")).toBeVisible();
	await expect(page.locator(".global-status")).toBeVisible();
	await expect(page.locator(".side-panel")).toBeVisible();
});

test("a tap focuses the editor input for the software keyboard", async ({
	page,
}) => {
	await openReady(page);
	const editorInput = page.getByRole("textbox", { name: "Editor content" });

	await expect(editorInput).not.toBeFocused();
	await page.locator(".monaco-editor .view-lines").tap();
	await expect(editorInput).toBeFocused();
});

test("the terminal menu opens where you can see and touch it", async ({
	page,
}) => {
	await openReady(page);
	await page.locator(".term-menu-btn").tap();
	const menu = page.locator(".term-menu");
	await expect(menu).toBeVisible();

	// Visible is not enough: it used to be inside a panel that clips its
	// overflow, drawn outside it and invisible while still reporting a box.
	const verdict = await menu.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const onScreen =
			box.left >= 0 &&
			box.top >= 0 &&
			box.right <= window.innerWidth &&
			box.bottom <= window.innerHeight;
		const atTop = document.elementFromPoint(
			box.left + box.width / 2,
			box.top + 12,
		);
		return { onScreen, reachable: Boolean(atTop?.closest(".term-menu")) };
	});
	expect(verdict.onScreen).toBe(true);
	expect(verdict.reachable).toBe(true);

	// And it does something: closing the terminal is the last item.
	await page.getByRole("menuitem", { name: /Close terminal/i }).tap();
	await expect(page.locator(".side-panel")).toHaveCount(0);
});

test("controls are big enough to hit with a finger", async ({ page }) => {
	await openReady(page);
	// Apple asks for 44x44. Full-width rows are exempt: they are easy to hit
	// along their length, and 44px tree rows would halve what a tree shows.
	const small = await page.evaluate(() => {
		const wanted = [
			".run-button",
			".chrome-icon",
			".mobile-key",
			".tab-add",
			".term-menu-btn",
			".auto-text",
		];
		return wanted.flatMap((selector) =>
			[...document.querySelectorAll(selector)]
				.map((element) => ({ selector, box: element.getBoundingClientRect() }))
				.filter(({ box }) => box.width > 0 && (box.width < 44 || box.height < 44))
				.map(({ selector: name, box }) =>
					`${name} ${Math.round(box.width)}x${Math.round(box.height)}`,
				),
		);
	});
	expect(small).toEqual([]);
});

test("no control covers another, and nothing spills sideways", async ({
	page,
}) => {
	await openReady(page);
	const trouble = await page.evaluate(() => {
		const buttons = [...document.querySelectorAll("button")]
			.map((element) => ({ element, box: element.getBoundingClientRect() }))
			.filter(({ box }) => box.width > 0 && box.height > 0);
		const overlaps: string[] = [];
		for (const [index, one] of buttons.entries())
			for (const other of buttons.slice(index + 1)) {
				if (
					one.element.contains(other.element) ||
					other.element.contains(one.element)
				)
					continue;
				const a = one.box;
				const b = other.box;
				if (
					a.right > b.left + 1 &&
					b.right > a.left + 1 &&
					a.bottom > b.top + 1 &&
					b.bottom > a.top + 1
				)
					overlaps.push(`${one.element.className} ∩ ${other.element.className}`);
			}
		const spills = [".editor-chrome", ".chrome-right", ".global-status"].filter(
			(selector) => {
				const element = document.querySelector(selector);
				return element ? element.scrollWidth > element.clientWidth + 1 : false;
			},
		);
		return { overlaps: overlaps.slice(0, 3), spills };
	});
	expect(trouble.overlaps).toEqual([]);
	expect(trouble.spills).toEqual([]);
});

test("you can run a program with nothing but taps", async ({ page }) => {
	await openReady(page);
	await page.getByRole("button", { name: "Open Ctrl commands" }).tap();
	await page
		.getByRole("toolbar", { name: "Mobile editor controls" })
		.getByRole("button", { name: "Run", exact: true })
		.tap();
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(page.locator(".inline-value").first()).toBeVisible();
	await expect(page.locator(".inline-value.stale")).toHaveCount(0);
});

test("the mobile keys keep editing focus and expose app commands", async ({
	page,
}) => {
	await openReady(page);
	const editorInput = page.getByRole("textbox", { name: "Editor content" });
	await page.locator(".monaco-editor .view-lines").tap();

	await page.getByRole("button", { name: "Tab", exact: true }).tap();
	await expect(editorInput).toBeFocused();
	await page.getByRole("button", { name: "Move cursor left" }).tap();
	await expect(editorInput).toBeFocused();

	await page.getByRole("button", { name: "Open Ctrl commands" }).tap();
	await expect(
		page.getByRole("button", { name: "Close Ctrl commands" }),
	).toHaveAttribute("aria-pressed", "true");
	await page
		.getByRole("toolbar", { name: "Mobile editor controls" })
		.getByRole("button", { name: "Commands", exact: true })
		.tap();
	await expect(page.getByRole("dialog", { name: "Find file" })).toBeVisible();
});
