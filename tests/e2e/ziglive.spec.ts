import { expect, test } from "@playwright/test";

async function openClean(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.getByText("ZigLive", { exact: true })).toBeVisible();
	await expect(page.locator(".monaco-editor")).toBeVisible();
}

async function replaceEditor(
	page: import("@playwright/test").Page,
	source: string,
): Promise<void> {
	await page.getByRole("textbox", { name: "Editor content" }).focus();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.insertText(source);
}

test("real Zig probes and ZLS capabilities work, then update by version", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();
	await expect(page.getByText("43 : i32", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "{ 40, 3, 43 }" }),
	).toBeVisible();

	await page.getByRole("button", { name: "Runtime" }).click();
	await expect(page.getByText(/completionProvider/)).toBeVisible();

	await replaceEditor(
		page,
		`const std = @import("std");

pub fn main() void {
    const price: i32 = 50;
    const tax: i32 = 3;
    const total = price + tax;
    const values = [_]i32{ price, tax, total };

    _ = values;
}
`,
	);
	await expect(page.locator(".inline-value.stale").first()).toBeVisible();
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(page.getByText("50 : i32", { exact: true })).toBeVisible();
	await expect(page.getByText("53 : i32", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "{ 50, 3, 53 }" }),
	).toBeVisible();
});

test("ZLS completion opens Monaco suggestions with real std symbols", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await replaceEditor(
		page,
		'const std = @import("std");\npub fn main() void { std',
	);
	const editorInput = page.getByRole("textbox", { name: "Editor content" });
	await editorInput.focus();
	await page.keyboard.type(".");
	await expect(page.locator(".suggest-widget.visible")).toBeVisible();
	await expect(page.getByText("AutoHashMap", { exact: true })).toBeVisible();
});

test("compile errors do not become current and repair reruns", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await replaceEditor(page, 'pub fn main() void { const x: i32 = "wrong"; }\n');
	await expect(page.locator(".state-compile_error")).toBeVisible();
	await expect(page.locator(".error-lens-message-error").first()).toBeVisible();
	await page.getByRole("button", { name: /Problems/ }).click();
	await expect(
		page.getByText(/expected type|cannot coerce|error/i).first(),
	).toBeVisible();

	await replaceEditor(page, "pub fn main() void { const x: i32 = 7; }\n");
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "7 : i32" }),
	).toBeVisible();
});

test("Auto Inspect can be replaced by a gutter manual probe", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await page.getByLabel("Auto Inspect").uncheck();
	await expect(page.locator(".inline-value")).toHaveCount(0);
	await page.locator(".manual-probe").first().click();
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();
});

test("panic is separate from probes and preserves stderr", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await replaceEditor(
		page,
		`const std = @import("std");
pub fn main() void {
    std.debug.print("before panic\\n", .{});
    std.debug.panic("expected panic", .{});
}
`,
	);
	await expect(page.locator(".state-runtime_error")).toBeVisible();
	await page.getByRole("button", { name: "Output" }).click();
	await expect(page.getByText(/before panic/)).toBeVisible();
	await expect(page.getByText(/panic: expected panic/).first()).toBeVisible();
	await page.getByRole("button", { name: /Problems/ }).click();
	await expect(page.getByText(/Program panicked|abnormally/).first()).toBeVisible();
});

test("infinite loop times out and Auto Run can be paused", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await replaceEditor(page, "pub fn main() void { while (true) {} }\n");
	await expect(page.locator(".state-timed_out")).toBeVisible({
		timeout: 25_000,
	});

	const autoRun = page.getByLabel("Auto Run");
	await autoRun.uncheck();
	await replaceEditor(page, "pub fn main() void { const answer = 9; }\n");
	await expect(page.locator(".state-idle")).toBeVisible();
	await page.getByRole("button", { name: "▶ Run" }).click();
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "9" }),
	).toBeVisible();
});
