import { expect, test } from "@playwright/test";

async function openClean(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator(".brand-chip")).toBeVisible();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	const vimMode = page.getByLabel("Vim Mode");
	if (await vimMode.isChecked()) await vimMode.uncheck();
}

async function replaceEditor(
	page: import("@playwright/test").Page,
	source: string,
): Promise<void> {
	// Paste instead of typing: Monaco applies auto-indent and brace
	// auto-closing to typed text, which corrupts multi-line snippets whose
	// first line opens a block. Paste inserts the text verbatim.
	await page
		.context()
		.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "http://127.0.0.1:5173",
		});
	await page.evaluate(
		async (text) => await navigator.clipboard.writeText(text),
		source,
	);
	await page.getByRole("textbox", { name: "Editor content" }).focus();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("ControlOrMeta+V");
}

test("real Zig probes and ZLS capabilities work, then update by version", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(page.locator(".cases-card")).toContainText("2 tests");
	await expect(page.locator(".cases-card")).toContainText("todos ok");
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

test("project tree supports imports, embedFile, and runtime input files", async ({
	page,
}) => {
	await openClean(page);
	page.once("dialog", (dialog) => dialog.accept("solver.zig"));
	await page.getByTitle("Crear archivo").click();
	await replaceEditor(
		page,
		'const std = @import("std");\npub fn answer() usize {\n    std.debug.print("solver module\\n", .{});\n    return @embedFile("input.txt").len;\n}\n',
	);

	page.once("dialog", (dialog) => dialog.accept("input.txt"));
	await page.getByTitle("Crear archivo").click();
	await replaceEditor(page, "abcd\n");

	await page.getByRole("button", { name: "main.zig" }).click();
	await replaceEditor(
		page,
		`const std = @import("std");
const solver = @import("solver.zig");
pub fn main(init: std.process.Init) !void {
    const data = try std.Io.Dir.cwd().readFileAlloc(init.io, "input.txt", init.arena.allocator(), .limited(1024));
    std.debug.print("embed {d} runtime {d}\\n", .{ solver.answer(), data.len });
}
`,
	);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(page.locator(".panel-content")).toContainText(
		"embed 6 runtime 6",
	);
	const moduleLog = page
		.locator(".output-entry.has-source")
		.filter({ hasText: "solver module" });
	await expect(moduleLog).toHaveAttribute(
		"title",
		/Generado por src\/solver\.zig:/,
	);
	await moduleLog.click();
	await expect(page.locator(".editor-header")).toContainText("src/solver.zig");
	await expect(page.locator(".log-source-line")).toBeVisible();

	page.once("dialog", (dialog) => dialog.accept("notes.tmp"));
	await page.getByTitle("Crear archivo").click();
	await replaceEditor(page, "temporary");
	page.once("dialog", (dialog) => dialog.accept("data/notes.txt"));
	await page.getByTitle("Renombrar archivo").click();
	await expect(
		page.getByRole("button", { name: "data/notes.txt" }),
	).toBeVisible();
	page.once("dialog", (dialog) => dialog.accept());
	await page.getByTitle("Eliminar archivo").click();
	await expect(
		page.getByRole("button", { name: "data/notes.txt" }),
	).toHaveCount(0);
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
	await expect(page.locator(".mode-chip")).toContainText(/INSERT/i);
	await page.keyboard.press("Escape");
	await expect(page.locator(".mode-chip")).toContainText(/NORMAL/i);
	await page.keyboard.press("o");
	await expect(page.locator(".mode-chip")).toContainText(/INSERT/i);
	await page.keyboard.type("// vim");
	await page.keyboard.press("Escape");
	await expect(page.locator(".mode-chip")).toContainText(/NORMAL/i);
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
	await expect(page.getByText("compiler · Ln 3, Col 20")).toBeVisible();

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
		/Generado por src\/main\.zig:4:9 · ejecución #2/,
	);
	await secondIteration.hover();
	await expect(secondIteration.locator(".log-origin-tooltip")).toContainText(
		"src/main.zig:4:9 · ejecución #2 · bucle 3:5 · i=1",
	);
	await expect(page.locator(".log-source-line")).toBeVisible();
	await expect(page.locator(".log-loop-line")).toBeVisible();
	await page.locator(".terminal-header").hover();
	await expect(page.locator(".log-source-line")).toHaveCount(0);
	await expect(page.locator(".log-loop-line")).toHaveCount(0);
	await secondIteration.click();
	await expect(page.locator(".cursor-status")).toHaveText("4:9");
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

test("zig test runner reports cases, error lens and tree badges", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await replaceEditor(
		page,
		[
			'const std = @import("std");',
			"pub fn main() void {}",
			'test "suma basica" { try std.testing.expectEqual(@as(i32, 4), 2 + 2); }',
			'test "falla esperada" { try std.testing.expectEqual(@as(u64, 366), 365); }',
			'test "se salta" { return error.SkipZigTest; }',
			"",
		].join("\n"),
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 30_000,
	});
	const cases = page.locator(".cases-card");
	await expect(cases).toContainText("3 tests");
	await expect(cases).toContainText("1 fallando");
	await expect(
		cases.locator(".case-row").filter({ hasText: "suma basica" }),
	).toContainText(/✓/);
	const failing = cases.locator(".case-row").filter({ hasText: "falla esperada" });
	await expect(failing).toContainText(/✗/);
	await expect(cases.locator(".case-message")).toContainText(
		/expected 366|TestExpectedEqual/,
	);
	await expect(page.locator(".test-lens-message.failed")).toBeVisible();
	await expect(
		page.locator(".tree-badge.fails").filter({ hasText: "1" }),
	).toBeVisible();
	await expect(page.locator(".history-row").first()).toBeVisible();
	await failing.click();
	await expect(page.locator(".cursor-status")).toHaveText("4:1");
});

test("command palette opens files and zen mode hides the chrome", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	page.once("dialog", (dialog) => dialog.accept("helper.zig"));
	await page.getByTitle("Crear archivo").click();
	await replaceEditor(page, "pub fn helper() void {}\n");
	await page.keyboard.press("ControlOrMeta+K");
	const palette = page.locator(".palette");
	await expect(palette).toBeVisible();
	await palette.getByLabel("Buscar archivo").fill("main.zig");
	await page.keyboard.press("Enter");
	await expect(palette).toHaveCount(0);
	await expect(page.locator(".editor-header")).toContainText("src/main.zig");

	await page.keyboard.press("ControlOrMeta+.");
	await expect(page.locator(".top-chrome")).toBeHidden();
	await expect(page.locator(".zen-pill")).toBeVisible();
	await page.locator(".zen-exit").click();
	await expect(page.locator(".top-chrome")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+J");
	await expect(page.locator(".side-panel")).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+J");
	await expect(page.locator(".side-panel")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+B");
	await expect(page.locator(".tree-card")).toHaveCount(0);
	await page.locator(".tree-restore").click();
	await expect(page.locator(".tree-card")).toBeVisible();
});

async function openRust(page: import("@playwright/test").Page): Promise<boolean> {
	await page.goto("/");
	const doctor = await page.evaluate(async () => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return body.checks.some(
			(check) =>
				check.name === "Rust cargo" && !check.detected.includes("disabled"),
		);
	});
	if (!doctor) return false;
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("ziglive.language.v1", "rust");
	});
	await page.reload();
	await expect(page.locator(".brand-chip")).toBeVisible();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	const vimMode = page.getByLabel("Vim Mode");
	if (await vimMode.isChecked()) await vimMode.uncheck();
	return true;
}

test("rust sessions run with inline values and tests", async ({ page }) => {
	test.skip(!(await openRust(page)), "cargo not available");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.locator(".editor-header")).toContainText("src/main.rs");
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "[40, 3, 43] : [i32; 3]" }),
	).toBeVisible();
	await expect(page.locator(".cases-card")).toContainText("2 tests");
	await expect(page.locator(".cases-card")).toContainText("todos ok");
	await expect(page.locator(".panel-content")).toContainText("cargo run");
});

test("rust compile errors, panics and failing tests map to visible lines", async ({
	page,
}) => {
	test.skip(!(await openRust(page)), "cargo not available");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await replaceEditor(page, 'fn main() {\n    let x: i32 = "no";\n}\n');
	await expect(page.locator(".state-compile_error")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.locator(".error-lens-message-error").first()).toBeVisible();
	await page.getByRole("button", { name: /Problems/ }).click();
	await expect(page.getByText(/mismatched types/).first()).toBeVisible();
	await expect(page.getByText(/src\/main\.rs · compiler · Ln 2/)).toBeVisible();

	await page.getByRole("button", { name: "Output" }).click();
	await replaceEditor(
		page,
		'fn main() {\n    for i in 0..3 {\n        println!("iter {i}");\n    }\n    panic!("boom");\n}\n\n#[test]\nfn falla() {\n    assert_eq!(1, 2);\n}\n',
	);
	await expect(page.locator(".state-runtime_error")).toBeVisible({
		timeout: 40_000,
	});
	const terminal = page.locator(".panel-content");
	await expect(
		terminal.locator("pre.error").filter({ hasText: /panicked at/ }).first(),
	).toBeVisible();
	const sourced = terminal
		.locator(".output-entry.has-source")
		.filter({ hasText: "iter 1" });
	await expect(sourced).toHaveAttribute(
		"title",
		/Generado por src\/main\.rs:3:9 · ejecución #2/,
	);
	await sourced.hover();
	await expect(sourced.locator(".log-origin-tooltip")).toContainText(
		"bucle 2:5 · i=1",
	);
	await expect(page.locator(".cases-card")).toContainText("1 fallando");
	await expect(page.locator(".case-message")).toContainText(
		/assertion `left == right` failed/,
	);
	await expect(page.locator(".test-lens-message.failed")).toBeVisible();
});

test("Ctrl+S formats the document and returns vim to normal mode", async ({
	page,
}) => {
	await page.goto("/");
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator(".brand-chip")).toBeVisible();
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await expect(page.getByLabel("Vim Mode")).toBeChecked();
	await replaceEditor(
		page,
		"pub fn main() void {\nconst  answer:i32=9;\n_=answer;\n}\n",
	);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await page.keyboard.press("i");
	await expect(page.locator(".mode-chip")).toHaveText(/INSERT/);
	await page.keyboard.press("ControlOrMeta+S");
	await expect(page.locator(".mode-chip")).toHaveText(/NORMAL/);
	await expect(page.locator(".view-lines")).toContainText(
		"const answer: i32 = 9;",
	);
});

test("one workspace runs both languages by extension", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	test.skip(
		(await page.getByRole("button", { name: "main.rs" }).count()) === 0,
		"cargo not available",
	);
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "main.rs" }).click();
	await expect(page.locator(".editor-header")).toContainText("src/main.rs");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.locator(".panel-content")).toContainText("cargo run");
	await expect(
		page.locator(".inline-value").filter({ hasText: "[40, 3, 43] : [i32; 3]" }),
	).toBeVisible();
	await expect(page.locator(".cases-card")).toContainText("2 tests");

	await page.getByRole("button", { name: "main.zig" }).click();
	await expect(page.locator(".editor-header")).toContainText("src/main.zig");
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.locator(".panel-content")).toContainText("zig build run");
});

test("folders group files and collapse in the tree", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+K");
	await page
		.getByRole("textbox", { name: "Buscar archivo" })
		.fill("utils/helper.zig");
	await page.keyboard.press("Enter");
	await expect(page.locator(".editor-header")).toContainText(
		"src/utils/helper.zig",
	);
	const folder = page.locator(".tree-folder").filter({ hasText: "utils" });
	await expect(folder).toBeVisible();
	await expect(
		page.getByRole("button", { name: "utils/helper.zig" }),
	).toBeVisible();
	await folder.click();
	await expect(
		page.getByRole("button", { name: "utils/helper.zig" }),
	).toHaveCount(0);
	await folder.click();
	await expect(
		page.getByRole("button", { name: "utils/helper.zig" }),
	).toBeVisible();

	page.once("dialog", (dialog) => dialog.accept("aoc"));
	await page.getByTitle("Crear carpeta").click();
	const aocRow = page
		.locator(".tree-folder-row")
		.filter({ hasText: "aoc" })
		.first();
	await expect(aocRow).toBeVisible();
	page.once("dialog", (dialog) => dialog.accept("aoc/day1.zig"));
	await aocRow.hover();
	await aocRow.locator(".folder-add").click();
	await expect(
		page.getByRole("button", { name: "aoc/day1.zig" }),
	).toBeVisible();
});
