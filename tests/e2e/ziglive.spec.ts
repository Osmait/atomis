import { expect, test } from "@playwright/test";

async function openClean(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.getByText("ZigLive", { exact: true })).toBeVisible();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	const vimMode = page.getByLabel("Vim Mode");
	if (await vimMode.isChecked()) await vimMode.uncheck();
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

test("Vim mode keeps native clipboard shortcuts", async ({ page, context }) => {
	const pageErrors: string[] = [];
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: "http://127.0.0.1:5173",
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openClean(page);
	await page.getByLabel("Vim Mode").check();
	const editorInput = page.getByRole("textbox", { name: "Editor content" });
	await page.locator(".view-lines").click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Copy", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Paste", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await editorInput.focus();
	await page.keyboard.press("i");
	await expect(page.locator(".vim-status")).toContainText(/INSERT/i);
	await page.keyboard.press("Escape");
	await expect(page.locator(".vim-status")).toContainText(/NORMAL/i);
	await page.keyboard.press("o");
	await expect(page.locator(".vim-status")).toContainText(/INSERT/i);
	await page.keyboard.type("// vim");
	await page.keyboard.press("Escape");
	await expect(page.locator(".vim-status")).toContainText(/NORMAL/i);
	await page.evaluate(() => navigator.clipboard.writeText("// clipboard"));
	await page.keyboard.press("i");
	await page.keyboard.press("Control+V");
	await page.keyboard.press("Escape");
	await expect(page.locator(".view-lines")).toContainText("// clipboard");
	await page.keyboard.press("Control+A");
	await page.keyboard.press("Control+C");
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toContain("// clipboard");
	await page.locator(".view-lines").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toContain("// clipboard");
	await page.evaluate(() => navigator.clipboard.writeText("// menu paste"));
	await page.locator(".view-lines").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Paste", exact: true }).click();
	await expect(page.locator(".view-lines")).toContainText("// menu paste");
	expect(pageErrors).toEqual([]);
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
	await replaceEditor(
		page,
		'const std = @import("std");\npub fn main() void {\n    std.debug.print("{hello}", .{});\n}\n',
	);
	await expect(page.locator(".state-compile_error")).toBeVisible();
	await expect(page.locator(".error-lens-message-error").first()).toBeVisible();
	await page.getByRole("button", { name: /Problems/ }).click();
	await expect(page.getByText(/too few arguments/i).first()).toBeVisible();
	await expect(page.getByText("zig-compiler · Ln 3, Col 20")).toBeVisible();

	await replaceEditor(page, "pub fn main() void { const x: i32 = 7; }\n");
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "7 : i32" }),
	).toBeVisible();
});

test("each run clears the terminal and colors only failures red", async ({
	page,
}) => {
	await openClean(page);
	await replaceEditor(
		page,
		'const std = @import("std");\npub fn main() void {\n    std.debug.print("{missing}", .{});\n}\n',
	);
	await expect(page.locator(".state-compile_error")).toBeVisible();
	const terminal = page.locator(".panel-content");
	await expect(terminal).toContainText("too few arguments");
	await expect(terminal.locator("pre.error").first()).toBeVisible();

	await replaceEditor(
		page,
		'const std = @import("std");\npub fn main() void {\n    for (0..3) |i| {\n        std.debug.print("iteration {d}\\n", .{i});\n    }\n}\n',
	);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(terminal).not.toContainText("too few arguments");
	await expect(terminal.locator("pre.program").first()).toContainText(
		"iteration 0",
	);
	await expect(terminal.locator("pre.error")).toHaveCount(0);
	const sourcedLogs = terminal.locator(".output-entry.has-source");
	await expect(sourcedLogs).toHaveCount(3);
	const secondIteration = sourcedLogs.filter({ hasText: "iteration 1" });
	await expect(secondIteration).toHaveAttribute(
		"title",
		/Generado por src\/main\.zig:4:13 · ejecución #2/,
	);
	await secondIteration.hover();
	await expect(secondIteration.locator(".log-origin-tooltip")).toContainText(
		"src/main.zig:4:13 · ejecución #2 · bucle 3:5 · i=1",
	);
	await expect(page.locator(".log-source-line")).toBeVisible();
	await expect(page.locator(".log-loop-line")).toBeVisible();
	await page.locator(".terminal-header").hover();
	await expect(page.locator(".log-source-line")).toHaveCount(0);
	await expect(page.locator(".log-loop-line")).toHaveCount(0);
	await secondIteration.click();
	await expect(page.locator(".cursor-status")).toHaveText("4:13");
	await expect(page.locator(".log-source-line")).toBeVisible();
	await expect(page.locator(".log-loop-line")).toBeVisible();

	await replaceEditor(
		page,
		'const std = @import("std");\npub fn main() void {\n    for (0..2) |i| std.debug.print("compact {d}\\n", .{i});\n}\n',
	);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	const compactLogs = terminal
		.locator(".output-entry.has-source")
		.filter({ hasText: "compact" });
	await expect(compactLogs).toHaveCount(2);
	const compactFirst = compactLogs.filter({ hasText: "compact 0" });
	await compactFirst.hover();
	await expect(compactFirst.locator(".log-origin-tooltip")).toContainText(
		/src\/main\.zig:3:\d+ · ejecución #1 · bucle 3:5 · i=0/,
	);
	await expect(page.locator(".log-source-line")).toBeVisible();
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
	const terminal = page.locator(".panel-content");
	await expect(
		terminal.locator("pre.program").filter({ hasText: "before panic" }),
	).toBeVisible();
	await expect(
		terminal.locator("pre.error").filter({ hasText: /panic:/ }),
	).toBeVisible();
	await expect(
		terminal
			.locator("pre.error")
			.filter({ hasText: /expected panic/ })
			.first(),
	).toBeVisible();
	await page.getByRole("button", { name: /Problems/ }).click();
	await expect(
		page.getByText(/Program panicked|abnormally/).first(),
	).toBeVisible();
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
