import { expect, test } from "@playwright/test";

/**
 * Settings live on the server now, so `localStorage.clear()` is no longer a
 * clean slate: the shared store would hydrate the previous test's choices —
 * or a real session's, when the suite runs on a developer's machine — back
 * into the next one. Emptying it here keeps every test independent.
 */
test.beforeEach(async ({ request, baseURL }) => {
	// The dev server answers on 5173 before the API behind it is listening,
	// so the first test can arrive to a proxy error. Nothing is stored yet
	// in that case, which is exactly the state this is trying to reach.
	const response = await request.get("/api/preferences").catch(() => undefined);
	if (!response?.ok()) return;
	const stored = (await response.json().catch(() => ({}))) as {
		preferences?: Record<string, string>;
	};
	const keys = Object.keys(stored.preferences ?? {});
	if (keys.length === 0) return;
	await request.put("/api/preferences", {
		// The guard only ever accepts the UI's own origin.
		headers: { origin: baseURL ?? "http://127.0.0.1:5173" },
		data: {
			preferences: Object.fromEntries(keys.map((key) => [key, null])),
		},
	});
});

/** The tabs the settings dialog groups its behaviour toggles into. */
const SETTINGS_TABS = ["Run", "Editor", "Appearance"] as const;

/**
 * Finds a behaviour toggle in an already-open dialog, selecting whichever
 * tab holds it. Searching rather than hard-coding the tab means moving a
 * toggle between tabs does not break every test that flips it.
 */
async function findToggle(
	page: import("@playwright/test").Page,
	label: string,
) {
	// Match the label element, not the whole button: hints mention other
	// toggles by name ("sandbox off — …") and would match too.
	const toggle = page.locator(".settings-toggle").filter({
		has: page.getByText(label, { exact: true }),
	});
	for (const tab of SETTINGS_TABS) {
		await page.locator(".settings-tab", { hasText: tab }).click();
		if ((await toggle.count()) > 0) return toggle;
	}
	throw new Error(`No settings toggle labelled ${label} on any tab`);
}

async function vimToggleOn(
	page: import("@playwright/test").Page,
): Promise<boolean> {
	const toggle = await findToggle(page, "Vim Mode");
	return await toggle
		.locator(".switch")
		.evaluate((element) => element.classList.contains("on"));
}

/** Opens the settings modal (gear), flips a behaviour toggle if needed. */
async function setToggle(
	page: import("@playwright/test").Page,
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

/** Types into the tree's inline draft input and confirms. */
async function fillTreeDraft(
	page: import("@playwright/test").Page,
	name: string,
): Promise<void> {
	const input = page.locator(".tree-draft input");
	await input.fill(name);
	await input.press("Enter");
}

/** Runs a file action from the tree's ⋯ dropdown. */
async function treeAction(
	page: import("@playwright/test").Page,
	name: string,
): Promise<void> {
	await page.locator(".tree-menu-btn").click();
	await page.getByRole("menuitem", { name, exact: true }).click();
}

/** Switches the terminal panel view through its ⋮ menu. */
async function openTermView(
	page: import("@playwright/test").Page,
	name: RegExp | string,
): Promise<void> {
	await page.locator(".term-menu-btn").click();
	await page
		.getByRole("menuitem", { name, exact: typeof name === "string" })
		.click();
}

async function openClean(page: import("@playwright/test").Page): Promise<void> {
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
			origin: process.env.ATOMIS_BASE_URL ?? "http://127.0.0.1:5173",
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
	await expect(page.locator(".test-score")).toHaveText("2/2");
	await expect(page.locator(".test-score")).toHaveClass(/ok/);
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();
	await expect(page.getByText("43 : i32", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "{ 40, 3, 43 }" }),
	).toBeVisible();

	await openTermView(page, "Runtime");
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
	await treeAction(page, "New file");
	await fillTreeDraft(page, "solver.zig");
	await replaceEditor(
		page,
		'const std = @import("std");\npub fn answer() usize {\n    std.debug.print("solver module\\n", .{});\n    return @embedFile("input.txt").len;\n}\n',
	);

	await treeAction(page, "New file");
	await fillTreeDraft(page, "input.txt");
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
		/Emitted by src\/solver\.zig:/,
	);
	await moduleLog.click();
	await expect(page.locator(".global-status")).toContainText("src/solver.zig");
	await expect(page.locator(".log-source-line")).toBeVisible();

	await treeAction(page, "New file");
	await fillTreeDraft(page, "notes.tmp");
	await replaceEditor(page, "temporary");
	await treeAction(page, "Rename file");
	await fillTreeDraft(page, "data/notes.txt");
	await expect(
		page.getByRole("button", { name: "data/notes.txt" }),
	).toBeVisible();
	page.once("dialog", (dialog) => dialog.accept());
	await treeAction(page, "Delete file");
	await expect(
		page.getByRole("button", { name: "data/notes.txt" }),
	).toHaveCount(0);
});

test("Vim mode keeps native clipboard shortcuts", async ({ page, context }) => {
	const pageErrors: string[] = [];
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: process.env.ATOMIS_BASE_URL ?? "http://127.0.0.1:5173",
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openClean(page);
	await setToggle(page, "Vim Mode", true);
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
	await openTermView(page, /Problems/);
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
		/Emitted by src\/main\.zig:4:9 · execution #2/,
	);
	await secondIteration.hover();
	await expect(secondIteration.locator(".log-origin-tooltip")).toContainText(
		"src/main.zig:4:9 · execution #2 · loop 3:5 · i=1",
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
		/src\/main\.zig:3:\d+ · execution #1 · loop 3:5 · i=0/,
	);
	await expect(page.locator(".log-source-line")).toBeVisible();
});

test("Auto Inspect can be replaced by a gutter manual probe", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await setToggle(page, "Auto Inspect", false);
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
	await openTermView(page, "Output");
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
	await openTermView(page, /Problems/);
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

	await setToggle(page, "Auto Run", false);
	await replaceEditor(page, "pub fn main() void { const answer = 9; }\n");
	await expect(page.locator(".state-idle")).toBeVisible();
	await page.locator(".run-button").click();
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
			'test "basic sum" { try std.testing.expectEqual(@as(i32, 4), 2 + 2); }',
			'test "falla esperada" { try std.testing.expectEqual(@as(u64, 366), 365); }',
			'test "se salta" { return error.SkipZigTest; }',
			"",
		].join("\n"),
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 30_000,
	});
	// the failing run auto-opens the tests drawer
	const cases = page.locator(".tests-drawer");
	await expect(cases).toBeVisible();
	await expect(cases.locator(".drawer-score")).toHaveText("2/3");
	await expect(cases.locator(".drawer-sub")).toContainText("1 failing");
	await expect(
		cases.locator(".case-row").filter({ hasText: "basic sum" }),
	).toBeVisible();
	await expect(
		cases.locator(".case-item.failed").filter({ hasText: "falla esperada" }),
	).toBeVisible();
	await expect(cases.locator(".case-message")).toContainText(
		/expected 366|TestExpectedEqual/,
	);
	await expect(page.locator(".test-lens-message.failed")).toBeVisible();
	await expect(
		page.locator(".tree-badge.fails").filter({ hasText: "1" }),
	).toBeVisible();

	// run history lives in the drawer's History tab
	await cases.locator(".drawer-tabs button", { hasText: "History" }).click();
	await expect(page.locator(".history-row").first()).toBeVisible();
	await cases.locator(".drawer-tabs button", { hasText: "Tests" }).click();

	await cases
		.locator(".case-item.failed .case-row")
		.filter({ hasText: "falla esperada" })
		.click();
	await expect(page.locator(".cursor-status")).toHaveText("4:1");

	// closing the drawer must stick: a rerun that is STILL failing may not
	// force it back open (it only auto-opens on the ok → failing transition)
	await page.locator(".drawer-close").click();
	await expect(page.locator(".tests-drawer")).toHaveCount(0);
	await page.getByRole("textbox", { name: "Editor content" }).focus();
	await page.keyboard.press("End");
	await page.keyboard.type(" ");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator(".test-score")).toHaveText("2/3");
	await expect(page.locator(".test-score")).toHaveClass(/err/);
	await expect(page.locator(".tests-drawer")).toHaveCount(0);
});

test("command palette opens files and zen mode hides the chrome", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await treeAction(page, "New file");
	await fillTreeDraft(page, "utils/helper.zig");
	await replaceEditor(page, "pub fn helper() void {}\n");
	await page.keyboard.press("ControlOrMeta+K");
	const palette = page.locator(".palette");
	await expect(palette).toBeVisible();
	await palette.getByLabel("Find file").fill("main.zig");
	await page.keyboard.press("Enter");
	await expect(palette).toHaveCount(0);
	await expect(page.locator(".global-status")).toContainText("src/main.zig");

	await page.keyboard.press("ControlOrMeta+.");
	await expect(page.locator(".editor-chrome")).toHaveCount(0);
	await expect(page.locator(".global-status")).toBeHidden();
	await expect(page.locator(".zen-pill")).toBeVisible();
	await page.locator(".zen-exit").click();
	await expect(page.locator(".editor-chrome")).toBeVisible();

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
		localStorage.setItem("atomis.scaffold.v1", "demo");
		localStorage.setItem("atomis.language.v1", "rust");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
	return true;
}

test("rust sessions run with inline values and tests", async ({ page }) => {
	test.skip(!(await openRust(page)), "cargo not available");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.rs");
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "[40, 3, 43] : [i32; 3]" }),
	).toBeVisible();
	await expect(page.locator(".test-score")).toHaveText("2/2");
	await expect(page.locator(".test-score")).toHaveClass(/ok/);
	await expect(page.locator(".panel-content")).toContainText("cargo run");

	// size_of_val layout reaches the peek panel
	await page.getByText("40 : i32", { exact: true }).click();
	await expect(page.locator(".peek-kv", { hasText: "size" })).toContainText(
		"4 B",
	);
	await expect(page.locator(".peek-kv", { hasText: "hex" })).toContainText(
		"0x00000028",
	);
	await page.locator(".peek-actions button", { hasText: "esc" }).click();
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
	await openTermView(page, /Problems/);
	await expect(page.getByText(/mismatched types/).first()).toBeVisible();
	await expect(page.getByText(/src\/main\.rs · compiler · Ln 2/)).toBeVisible();

	await openTermView(page, "Output");
	await replaceEditor(
		page,
		'fn main() {\n    for i in 0..3 {\n        println!("iter {i}");\n    }\n    panic!("boom");\n}\n\n#[test]\nfn falla() {\n    assert_eq!(1, 2);\n}\n',
	);
	await expect(page.locator(".state-runtime_error")).toBeVisible({
		timeout: 40_000,
	});
	// the failing test auto-opens the drawer: verify, then close it to
	// reach the output underneath
	await expect(page.locator(".drawer-sub")).toContainText("1 failing", {
		timeout: 40_000,
	});
	await expect(page.locator(".case-message")).toContainText(
		/assertion `left == right` failed/,
	);
	await expect(page.locator(".test-lens-message.failed")).toBeVisible();
	await page.locator(".drawer-close").click();

	const terminal = page.locator(".panel-content");
	await expect(
		terminal.locator("pre.error").filter({ hasText: /panicked at/ }).first(),
	).toBeVisible();
	const sourced = terminal
		.locator(".output-entry.has-source")
		.filter({ hasText: "iter 1" });
	await expect(sourced).toHaveAttribute(
		"title",
		/Emitted by src\/main\.rs:3:9 · execution #2/,
	);
	await sourced.hover();
	await expect(sourced.locator(".log-origin-tooltip")).toContainText(
		"loop 2:5 · i=1",
	);
});

test("Ctrl+S formats the document and returns vim to normal mode", async ({
	page,
}) => {
	await page.goto("/");
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await page.locator(".chrome-icon").click();
	expect(await vimToggleOn(page)).toBe(true);
	await page.keyboard.press("Escape");
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

test("multi-file imports run in every language", async ({ page }) => {
	await openClean(page);
	// A sandboxed session starts with cold toolchain caches (they live in
	// the workspace, not the user's home), so the first compile of each
	// language pays a one-off penalty; this spec compiles five of them.
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	const doctor = await page.evaluate(async () => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return Object.fromEntries(
			body.checks.map((check) => [check.name, check.detected]),
		) as Record<string, string>;
	});
	const available = (name: string): boolean =>
		!(doctor[name] ?? "").includes("degraded");

	const flows: {
		gate: string;
		entry: string;
		helper: [string, string];
		main: string;
		expect: string;
	}[] = [
		{
			gate: "Rust cargo",
			entry: "main.rs",
			helper: ["helper.rs", "pub fn doubled(x: i32) -> i32 {\n    x * 2\n}\n"],
			main: "mod helper;\n\nfn main() {\n    let result = helper::doubled(21);\n    let _ = result;\n}\n",
			expect: "42 : i32",
		},
		{
			gate: "Go go",
			entry: "main.go",
			helper: [
				"gohelper.go",
				"package main\n\nfunc doubled(x int) int {\n\treturn x * 2\n}\n",
			],
			main: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tresult := doubled(21)\n\tfmt.Println(result)\n}\n',
			expect: "42 : int",
		},
		{
			gate: "Node.js",
			entry: "main.ts",
			helper: [
				"tshelper.ts",
				"export function doubled(x: number): number {\n\treturn x * 2;\n}\n",
			],
			main: 'import { doubled } from "./tshelper.ts";\n\nconst result = doubled(21);\nconsole.log(result);\n',
			expect: "42 : number",
		},
		{
			gate: "Python python3",
			entry: "main.py",
			helper: ["pyhelper.py", "def doubled(x):\n    return x * 2\n"],
			main: "from pyhelper import doubled\n\nresult = doubled(21)\nprint(result)\n",
			expect: "42 : int",
		},
		{
			gate: "C/C++ clang",
			entry: "main.c",
			helper: ["chelper.c", "int doubled(int x) {\n\treturn x * 2;\n}\n"],
			main: '#include <stdio.h>\n\nint doubled(int x);\n\nint main(void) {\n\tint result = doubled(21);\n\tprintf("%d\\n", result);\n\treturn 0;\n}\n',
			expect: "42 : int",
		},
	];
	for (const flow of flows) {
		if (!available(flow.gate)) continue;
		await treeAction(page, "New file");
		await fillTreeDraft(page, flow.helper[0]);
		await replaceEditor(page, flow.helper[1]);
		await page.getByRole("button", { name: flow.entry, exact: true }).click();
		await expect(page.locator(".status-path")).toContainText(flow.entry);
		await replaceEditor(page, flow.main);
		await expect(page.getByText(flow.expect, { exact: true })).toBeVisible({
			timeout: 60_000,
		});
	}
});

test("programs that open TCP/HTTP servers are killed at the timeout", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();

	// The sandbox denies the network outright where the kernel supports it,
	// so a server never binds; this spec is about the fallback policy that
	// applies with the sandbox off (or on kernels below Landlock ABI 4).
	const sandboxed = await page.evaluate(async () => {
		const response = await fetch("/api/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ language: "zig", scaffold: "minimal" }),
		});
		return (
			((await response.json()) as { sandboxSupport?: string })
				.sandboxSupport === "files+network"
		);
	});
	if (sandboxed) await setToggle(page, "Sandbox", false);

	// A Node HTTP server blocks forever: the run must end as timed_out and
	// the process-group kill must leave nothing listening on the port.
	await page.getByRole("button", { name: "main.ts", exact: true }).click();
	await replaceEditor(
		page,
		'import { createServer } from "node:http";\n\nconst server = createServer((_req, res) => {\n\tres.end("hola");\n});\nserver.listen(39123, "127.0.0.1", () => {\n\tconsole.log("escuchando en 39123");\n});\n',
	);
	await expect(page.locator(".state-timed_out")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator(".panel-content")).toContainText(
		"escuchando en 39123",
	);
	await page.waitForTimeout(600);
	const httpPortFree = await page.evaluate(async () => {
		try {
			await fetch("http://127.0.0.1:39123/", {
				mode: "no-cors",
				signal: AbortSignal.timeout(1000),
			});
			return false;
		} catch {
			return true;
		}
	});
	expect(httpPortFree).toBe(true);

	// Same policy for a raw TCP listener in Python.
	await page.getByRole("button", { name: "main.py", exact: true }).click();
	await replaceEditor(
		page,
		'import socketserver\n\n\nclass Handler(socketserver.BaseRequestHandler):\n    def handle(self):\n        self.request.sendall(b"hola")\n\n\nwith socketserver.TCPServer(("127.0.0.1", 39124), Handler) as server:\n    print("escuchando en 39124")\n    server.serve_forever()\n',
	);
	await expect(page.locator(".state-timed_out")).toBeVisible({
		timeout: 30_000,
	});
	await page.waitForTimeout(600);
	const tcpPortFree = await page.evaluate(async () => {
		try {
			await fetch("http://127.0.0.1:39124/", {
				mode: "no-cors",
				signal: AbortSignal.timeout(1000),
			});
			return false;
		} catch {
			return true;
		}
	});
	expect(tcpPortFree).toBe(true);
	if (sandboxed) await setToggle(page, "Sandbox", true);
});

test("leader key navigates tree and terminal app-wide", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();

	// With vim off, Space inside the editor must keep typing spaces — the
	// leader only fires from vim NORMAL mode (or outside the editor).
	await setToggle(page, "Vim Mode", true);
	await page.locator(".monaco-editor").click();
	await page.keyboard.press("Escape");
	await expect(page.locator(".mode-chip")).toHaveText("NORMAL");
	await page.keyboard.press(" ");
	await expect(page.locator(".mode-chip")).toHaveText("LEADER");
	await page.keyboard.press("e");
	await expect(page.locator(".mode-chip")).toHaveText("TREE");
	await expect(page.locator(".tree-card")).toHaveClass(/kb-zone/);

	// j/k move the selection; Enter opens and returns to the editor
	await page.keyboard.press("j");
	await page.keyboard.press("j");
	await expect(page.locator(".kb-sel")).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.locator(".mode-chip")).not.toHaveText("TREE");

	// leader e on a focused tree closes it
	await page.keyboard.press(" ");
	await page.keyboard.press("e");
	await expect(page.locator(".mode-chip")).toHaveText("TREE");
	await page.keyboard.press(" ");
	await page.keyboard.press("e");
	await expect(page.locator(".tree-card")).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+B");
	await expect(page.locator(".tree-card")).toBeVisible();

	// leader h/l move focus across panels: editor → tree → editor → terminal
	await page.keyboard.press(" ");
	await page.keyboard.press("h");
	await expect(page.locator(".mode-chip")).toHaveText("TREE");
	await page.keyboard.press(" ");
	await page.keyboard.press("l");
	await expect(page.locator(".mode-chip")).not.toHaveText("TREE");
	await page.keyboard.press(" ");
	await page.keyboard.press("l");
	await expect(page.locator(".mode-chip")).toHaveText("TERMINAL");

	// Shift+L / Shift+H cycle open tabs; leader+o closes the others
	await page.locator(".tree-file", { hasText: "main.rs" }).first().click();
	await expect(page.locator(".status-path")).toContainText("src/main.rs");
	await page.locator(".monaco-editor").click();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Shift+H");
	await expect(page.locator(".status-path")).not.toContainText("src/main.rs");
	await page.keyboard.press("Shift+L");
	await expect(page.locator(".status-path")).toContainText("src/main.rs");
	await page.keyboard.press(" ");
	await page.keyboard.press("o");
	await expect(page.locator(".buffer-tab")).toHaveCount(1);
	await expect(page.locator(".buffer-tab")).toContainText("main.rs");

	// leader t focuses the terminal; leader t again closes it
	await page.keyboard.press("Escape");
	await page.keyboard.press(" ");
	await page.keyboard.press("t");
	await expect(page.locator(".mode-chip")).toHaveText("TERMINAL");
	await expect(page.locator(".side-panel")).toHaveClass(/kb-zone/);
	await page.keyboard.press(" ");
	await page.keyboard.press("t");
	await expect(page.locator(".side-panel")).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+J");
	await expect(page.locator(".side-panel")).toBeVisible();
});

test("low-level peek: bits, bitops, struct layout and value formats", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator(".inline-value").first()).toBeVisible({
		timeout: 60_000,
	});

	// Global value format switcher (settings modal + ⌘1-5) re-renders hints.
	await page.locator(".chrome-icon").click();
	await page.locator(".fmt-switch button", { hasText: "hex" }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByText("0x00000028 : i32", { exact: true })).toBeVisible();
	await page.keyboard.press("ControlOrMeta+3");
	await expect(
		page
			.getByText("0b0000_0000_0000_0000_0000_0000_0010_1000 : i32", {
				exact: true,
			})
			.first(),
	).toBeVisible();
	await page.keyboard.press("ControlOrMeta+1");
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();

	await replaceEditor(
		page,
		'const std = @import("std");\n\nconst Pixel = extern struct { r: u8, g: u8, b: u8, a: u8 };\n\npub fn main() !void {\n    var flags: u8 = 0b0010_1011;\n    flags = flags << 1;\n    const px = Pixel{ .r = 255, .g = 128, .b = 64, .a = 255 };\n    std.debug.print("{x} {any}\\n", .{ flags, px.r });\n}\n',
	);
	await expect(page.getByText("86 : u8", { exact: true })).toBeVisible({
		timeout: 60_000,
	});

	// Assignment re-probe + peek anchored under the line.
	await page.getByText("86 : u8", { exact: true }).click();
	await expect(page.locator(".peek-panel")).toBeVisible();
	await expect(page.locator(".peek-bit")).toHaveCount(8);
	await expect(page.locator(".peek-bitop-row")).toHaveCount(3);
	await expect(page.locator(".peek-kv", { hasText: "size" })).toContainText(
		"1 B",
	);
	await expect(page.locator(".peek-kv", { hasText: "hex" })).toContainText(
		"0x56",
	);

	// Bit flips are local what-ifs: value changes, reset restores.
	await page.locator(".peek-bit").first().click();
	await expect(page.locator(".peek-kv", { hasText: "dec" })).toContainText(
		"214",
	);
	await page.locator(".peek-actions button", { hasText: "reset" }).click();
	await expect(page.locator(".peek-kv", { hasText: "dec" })).toContainText(
		"86",
	);
	await page.locator(".peek-actions button", { hasText: "esc" }).click();
	await expect(page.locator(".peek-panel")).toHaveCount(0);

	// Struct peek shows compiler-real field offsets.
	await page.getByText("Pixel · 4 B · align 1", { exact: false }).click();
	await expect(page.locator(".peek-field-row")).toHaveCount(5);
	await expect(page.locator(".peek-field-row").nth(2)).toContainText("+1");
	await page.locator(".peek-actions button", { hasText: "esc" }).click();
	await expect(page.locator(".peek-panel")).toHaveCount(0);
});

test("one workspace runs both languages by extension", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	test.skip(
		(await page.getByRole("button", { name: "main.rs" }).count()) === 0,
		"cargo not available",
	);
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible();

	// Entering the file is enough: the inspect re-runs for the new language
	// without typing or a manual run.
	await page.getByRole("button", { name: "main.rs" }).click();
	await expect(page.locator(".global-status")).toContainText("src/main.rs");
	await expect(page.locator(".panel-content")).toContainText("cargo run", {
		timeout: 40_000,
	});
	await expect(
		page.locator(".inline-value").filter({ hasText: "[40, 3, 43] : [i32; 3]" }),
	).toBeVisible({ timeout: 40_000 });
	await expect(page.locator(".test-score")).toHaveText("2/2");

	await page.getByRole("button", { name: "main.zig" }).click();
	await expect(page.locator(".global-status")).toContainText("src/main.zig");
	await expect(page.locator(".panel-content")).toContainText("zig build run", {
		timeout: 40_000,
	});
	await expect(page.getByText("40 : i32", { exact: true })).toBeVisible({
		timeout: 40_000,
	});
});

test("folders group files and collapse in the tree", async ({ page }) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+K");
	await page
		.getByRole("textbox", { name: "Find file" })
		.fill("utils/helper.zig");
	await page.keyboard.press("Enter");
	await expect(page.locator(".global-status")).toContainText(
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

	await treeAction(page, "New folder");
	await fillTreeDraft(page, "aoc");
	const aocRow = page
		.locator(".tree-folder-row")
		.filter({ hasText: "aoc" })
		.first();
	await expect(aocRow).toBeVisible();
	await aocRow.hover();
	await aocRow.locator(".folder-add").click();
	await fillTreeDraft(page, "day1.zig");
	await expect(
		page.getByRole("button", { name: "aoc/day1.zig" }),
	).toBeVisible();

	// the src root row folds the whole tree
	await page.locator(".tree-root-toggle").click();
	await expect(page.locator(".tree-file")).toHaveCount(0);
	await page.locator(".tree-root-toggle").click();
	await expect(page.locator(".tree-file").first()).toBeVisible();

	// right-click: create inside a folder from the context menu
	await page.locator(".tree-folder-row").first().click({ button: "right" });
	await expect(page.locator(".tree-context-menu")).toBeVisible();
	await page
		.getByRole("menuitem", { name: /New file en/ })
		.click();
	await expect(page.locator(".tree-draft input")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator(".tree-draft")).toHaveCount(0);

	// right-click a file: rename/delete available
	await page.locator(".tree-file").first().click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Rename", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator(".tree-context-menu")).toHaveCount(0);
});

async function openGo(page: import("@playwright/test").Page): Promise<boolean> {
	await page.goto("/");
	const available = await page.evaluate(async () => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return body.checks.some(
			(check) => check.name === "Go go" && !check.detected.includes("degraded"),
		);
	});
	if (!available) return false;
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
		localStorage.setItem("atomis.language.v1", "go");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
	return true;
}

test("go sessions run with inline values, tests and mapped diagnostics", async ({
	page,
}) => {
	test.skip(!(await openGo(page)), "go not available");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.go");
	await expect(page.getByText("40 : int", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "[]int{40, 3, 43} : []int" }),
	).toBeVisible();

	// reflect-derived layout reaches the peek panel (go int = 8 B / 64 bits)
	await page.getByText("40 : int", { exact: true }).click();
	await expect(page.locator(".peek-kv", { hasText: "size" })).toContainText(
		"8 B",
	);
	await expect(page.locator(".peek-bit")).toHaveCount(64);
	await page.locator(".peek-actions button", { hasText: "esc" }).click();
	await expect(page.locator(".test-score")).toHaveText("2/2");
	await expect(page.locator(".test-score")).toHaveClass(/ok/);
	await expect(page.locator(".panel-content")).toContainText("go run");

	// regression: opening a Go file must never route its content to ZLS
	await page.getByRole("button", { name: "main_test.go", exact: true }).click();
	await expect(page.locator(".global-status")).toContainText(
		"src/main_test.go",
	);
	await page.waitForTimeout(1500);
	await expect(page.locator(".error-lens-message")).toHaveCount(0);
	await page.getByRole("button", { name: "main.go", exact: true }).click();

	await replaceEditor(
		page,
		'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar x int = "no"\n\tfmt.Println(x)\n}\n',
	);
	await expect(page.locator(".state-compile_error")).toBeVisible({
		timeout: 60_000,
	});
	await openTermView(page, /Problems/);
	await expect(page.getByText(/cannot use "no"/).first()).toBeVisible();
	await expect(
		page.getByText(/src\/main\.go · compiler · Ln 6/).first(),
	).toBeVisible();

	await openTermView(page, "Output");
	await replaceEditor(
		page,
		'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("antes")\n\tpanic("boom")\n}\n',
	);
	await expect(page.locator(".state-runtime_error")).toBeVisible({
		timeout: 60_000,
	});
	await expect(
		page
			.locator(".panel-content")
			.locator("pre.error")
			.filter({ hasText: /panic: boom/ })
			.first(),
	).toBeVisible();
});

test("ts sessions run with inline values, tests and non-blocking type errors", async ({
	page,
}) => {
	await page.goto("/");
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
		localStorage.setItem("atomis.language.v1", "ts");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.ts");
	await expect(page.getByText("40 : number", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "[ 40, 3, 43 ] : Array" }),
	).toBeVisible();
	await expect(page.locator(".test-score")).toHaveText("2/2");
	await expect(page.locator(".test-score")).toHaveClass(/ok/);
	await expect(page.locator(".panel-content")).toContainText("node main.ts");

	// A type error surfaces as a diagnostic but the program still runs.
	await replaceEditor(
		page,
		'const bad: number = "no";\nconsole.log("still running:", bad);\n',
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".panel-content")).toContainText(
		"still running: no",
	);
	await openTermView(page, /Problems/);
	await expect(
		page.getByText(/Type 'string' is not assignable/).first(),
	).toBeVisible();

	// An uncaught throw is a runtime error with a mapped location.
	await openTermView(page, "Output");
	await replaceEditor(
		page,
		'console.log("antes");\nthrow new Error("boom esperado");\n',
	);
	await expect(page.locator(".state-runtime_error")).toBeVisible({
		timeout: 60_000,
	});
	await expect(
		page
			.locator(".panel-content")
			.locator("pre.error")
			.filter({ hasText: /boom esperado/ })
			.first(),
	).toBeVisible();
});

test("python sessions run with inline values, tests and tracebacks", async ({
	page,
}) => {
	await page.goto("/");
	const available = await page.evaluate(async () => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return body.checks.some(
			(check) =>
				check.name === "Python python3" &&
				!check.detected.includes("degraded"),
		);
	});
	test.skip(!available, "python3 not available");
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
		localStorage.setItem("atomis.language.v1", "py");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.py");
	await expect(page.getByText("40 : int", { exact: true })).toBeVisible();
	await expect(
		page.locator(".inline-value").filter({ hasText: "[40, 3, 43] : list" }),
	).toBeVisible();
	await expect(page.locator(".test-score")).toHaveText("2/2");
	await expect(page.locator(".test-score")).toHaveClass(/ok/);
	await expect(page.locator(".panel-content")).toContainText("python3 main.py");

	// Syntax errors come from the instrumenter's ast.parse with positions.
	await replaceEditor(page, "x = (\n");
	await expect(page.locator(".state-compile_error")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".error-lens-message-error").first()).toBeVisible();

	// An uncaught raise paints the traceback red and maps the location.
	await replaceEditor(
		page,
		'print("antes")\nraise ValueError("boom esperado")\n',
	);
	await expect(page.locator(".state-runtime_error")).toBeVisible({
		timeout: 60_000,
	});
	const terminal = page.locator(".panel-content");
	await expect(
		terminal.locator("pre.error").filter({ hasText: /boom esperado/ }).first(),
	).toBeVisible();
	await expect(
		terminal.locator("pre.error").filter({ hasText: /Traceback/ }).first(),
	).toBeVisible();
	await openTermView(page, /Problems/);
	await expect(
		page.getByText(/src\/main\.py · runtime · Ln 2/).first(),
	).toBeVisible();
});

async function openCFamily(
	page: import("@playwright/test").Page,
	language: "c" | "cpp",
): Promise<boolean> {
	await page.goto("/");
	const available = await page.evaluate(async () => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return body.checks.some(
			(check) =>
				check.name === "C/C++ clang" && !check.detected.includes("degraded"),
		);
	});
	if (!available) return false;
	await page.evaluate((lang) => {
		localStorage.clear();
		localStorage.setItem("atomis.scaffold.v1", "demo");
		localStorage.setItem("atomis.language.v1", lang);
	}, language);
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
	return true;
}

test("c sessions run with typed probes, tests and mapped diagnostics", async ({
	page,
}) => {
	test.skip(!(await openCFamily(page, "c")), "clang not available");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.c");
	await expect(page.getByText("40 : int", { exact: true })).toBeVisible();
	await expect(page.locator(".test-score")).toHaveText("2/2");
	await expect(page.locator(".test-score")).toHaveClass(/ok/);

	await replaceEditor(
		page,
		"#include <stdio.h>\n\nint main(void) {\n\tint x = 5\n\treturn 0;\n}\n",
	);
	await expect(page.locator(".state-compile_error")).toBeVisible({
		timeout: 60_000,
	});
	await openTermView(page, /Problems/);
	await expect(
		page.getByText(/expected ';' at end of declaration/).first(),
	).toBeVisible();
	await expect(
		page.getByText(/src\/main\.c · compiler · Ln 4/).first(),
	).toBeVisible();
});

test("cpp sessions run with stream previews and failing asserts", async ({
	page,
}) => {
	test.skip(!(await openCFamily(page, "cpp")), "clang not available");
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".global-status")).toContainText("src/main.cpp");
	await expect(
		page.locator(".inline-value").filter({ hasText: "total : std::basic_string" }),
	).toBeVisible();
	await expect(page.locator(".test-score")).toHaveText("2/2");

	// regression: LSP features must work on a freshly opened file WITHOUT
	// typing — didOpen used to be dropped while the socket was connecting
	await page.locator('.view-line span:text-is("apply_tax")').first().hover();
	await expect(
		page.locator(".monaco-hover:not(.hidden)").first(),
	).toContainText("apply_tax", { timeout: 15_000 });
	await page.keyboard.press("Escape");

	// a failing assert aborts the run and correlates the stderr message
	await page.getByRole("button", { name: "main_test.cpp", exact: true }).click();
	await replaceEditor(
		page,
		"#include <cassert>\n\nint apply_tax(int price, int tax);\n\nvoid test_falla() {\n\tassert(apply_tax(40, 0) == 41);\n}\n",
	);
	await expect(page.locator(".drawer-sub")).toContainText("1 failing", {
		timeout: 60_000,
	});
	await expect(page.locator(".case-message")).toContainText(/Assertion|assert/);
	await expect(page.locator(".test-lens-message.failed")).toBeVisible();
});

test("workspace starts minimal, loads the demo and clears back", async ({
	page,
}) => {
	await page.goto("/");
	// No scaffold seed: the app's default is the minimal workspace.
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".tree-file")).toHaveCount(1);
	await expect(page.locator(".tree-file").first()).toContainText("main.zig");
	// Probes and tests still run on the minimal scaffold.
	await expect(page.getByText("43 : i32", { exact: true })).toBeVisible();
	await expect(page.locator(".test-score")).toHaveText("2/2");

	page.on("dialog", (dialog) => void dialog.accept());
	await page.locator(".tree-menu-btn").click();
	await page.getByRole("menuitem", { name: "Load demo workspace" }).click();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	expect(await page.locator(".tree-file").count()).toBeGreaterThan(3);

	await page.locator(".tree-menu-btn").click();
	await page.getByRole("menuitem", { name: "Clear workspace" }).click();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".tree-file")).toHaveCount(1, {
		timeout: 60_000,
	});
	await expect(page.locator(".tree-file").first()).toContainText("main.zig");
});

test("inline logs render output beside its line and toggle off", async ({
	page,
}) => {
	await openClean(page);
	await replaceEditor(
		page,
		'const std = @import("std");\n\npub fn main() void {\n\tvar i: usize = 0;\n\twhile (i < 4) : (i += 1) {\n\t\tstd.debug.print("tick {d}\\n", .{i});\n\t}\n}\n',
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	// Console Ninja-style ghost text: latest value plus the hit count.
	await expect(page.locator(".inline-log")).toContainText("tick 3 ×4");

	await setToggle(page, "Inline logs", false);
	await expect(page.locator(".inline-log")).toHaveCount(0);
	await setToggle(page, "Inline logs", true);
	await expect(page.locator(".inline-log")).toContainText("tick 3 ×4");
});

test("vim gets quick-scope targets and editor-integrated commands", async ({
	page,
}) => {
	await openClean(page);
	await setToggle(page, "Vim Mode", true);
	await page.locator(".monaco-editor").click();
	await page.keyboard.press("Escape");
	await page.keyboard.type("gg");
	// clever-f: pressing f alone must not draw anything…
	await page.keyboard.press("f");
	await expect(page.locator(".qs-match")).toHaveCount(0);
	// …the matches appear once the character is chosen (several t's on
	// line 1), persist across ; repeats, and any other key clears them.
	await page.keyboard.press("t");
	await expect(page.locator(".qs-match").first()).toBeVisible();
	await page.keyboard.press(";");
	expect(await page.locator(".qs-match").count()).toBeGreaterThan(0);
	await page.keyboard.press("j");
	await expect(page.locator(".qs-match")).toHaveCount(0);
	await page.keyboard.type("gg");

	// gcc toggles the comment through Monaco's action.
	await page.keyboard.type("gcc");
	await expect(page.locator(".view-lines")).toContainText("// const std");
	await page.keyboard.type("gcc");
	await expect(page.locator(".view-lines")).not.toContainText("// const std");

	// vim-surround (gs namespace): gsw wraps the word, gsc swaps the
	// pair (single keypress into the status-bar dialog), gsd removes it.
	await page.keyboard.type("gg");
	await page.keyboard.type('gsw"');
	await expect(page.locator(".view-lines")).toContainText('"const" std');
	await page.keyboard.type('gsc"');
	await page.keyboard.press("'");
	await expect(page.locator(".view-lines")).toContainText("'const' std");
	await page.keyboard.type("gsd'");
	await expect(page.locator(".view-lines")).not.toContainText("'const'");
	// visual gs wraps the selection.
	await page.keyboard.type("viwgs)");
	await expect(page.locator(".view-lines")).toContainText("(const) std");
	await page.keyboard.type("gsd)");
	await expect(page.locator(".view-lines")).not.toContainText("(const)");

	// Insert mode must never arm the overlay, even on an f keypress.
	await page.keyboard.type("i");
	await page.keyboard.press("f");
	await page.keyboard.press("t");
	await expect(page.locator(".qs-match")).toHaveCount(0);
	await page.keyboard.press("Escape");
});

test("vim LSP keys, folds and workspace ex commands", async ({ page }) => {
	await openClean(page);
	await setToggle(page, "Vim Mode", true);
	await page.locator(".monaco-editor").click();
	await page.keyboard.press("Escape");

	// Folds through Monaco's folding contribution.
	await page.keyboard.type("zM");
	await expect(
		page.locator(".codicon-folding-collapsed").first(),
	).toBeVisible();
	await page.keyboard.type("zR");
	await expect(page.locator(".codicon-folding-collapsed")).toHaveCount(0);

	// gd: land on the applyTax call (search hits the definition first;
	// * jumps forward to the test-name string, then the real call).
	await page.keyboard.type("gg/applyTax.price");
	await page.keyboard.press("Enter");
	await expect(page.locator(".cursor-status")).toHaveText("12:4");
	await page.keyboard.type("**");
	await expect(page.locator(".cursor-status")).toHaveText("18:47");
	await page.keyboard.type("gd");
	await expect(page.locator(".cursor-status")).toHaveText("12:4", {
		timeout: 15_000,
	});

	// K: hover documentation for the symbol under the cursor.
	await page.keyboard.press("K");
	await expect(page.locator(".monaco-hover:not(.hidden)")).toContainText(
		"applyTax",
		{ timeout: 15_000 },
	);
	await page.keyboard.press("Escape");

	// Visual gc comments the selected line and gcc restores it.
	await page.keyboard.type("ggVgc");
	await expect(page.locator(".view-lines")).toContainText("// const std");
	await page.keyboard.type("gcc");
	await expect(page.locator(".view-lines")).not.toContainText("// const std");

	// gr opens the references peek for the symbol under the cursor
	// (12G lands on fn, w on applyTax).
	await page.keyboard.type("12Gw");
	await expect(page.locator(".cursor-status")).toHaveText("12:4");
	await page.keyboard.type("gr");
	await expect(page.locator(".zone-widget")).toBeVisible({
		timeout: 15_000,
	});
	await page.keyboard.press("Escape");
	await expect(page.locator(".zone-widget")).toHaveCount(0);

	// gss wraps the whole line; undo restores it.
	await page.keyboard.type("gg");
	await page.keyboard.type('gss"');
	await expect(page.locator(".view-lines")).toContainText(
		'"const std = @import("std");"',
	);
	await page.keyboard.type("u");
	await expect(page.locator(".view-lines")).not.toContainText(
		'"const std = @import("std");"',
	);

	// :e creates and opens a file; :bd closes its tab; :only keeps one.
	await page.keyboard.type(":e util.zig");
	await page.keyboard.press("Enter");
	await expect(page.locator(".buffer-tab")).toHaveCount(2);
	await expect(page.locator(".buffer-tab.active")).toContainText("util.zig");
	await page.keyboard.type(":bd");
	await page.keyboard.press("Enter");
	await expect(page.locator(".buffer-tab")).toHaveCount(1);
	await expect(page.locator(".buffer-tab.active")).toContainText("main.zig");
	await page.keyboard.type(":e util.zig");
	await page.keyboard.press("Enter");
	await expect(page.locator(".buffer-tab")).toHaveCount(2);
	await page.keyboard.type(":only");
	await page.keyboard.press("Enter");
	await expect(page.locator(".buffer-tab")).toHaveCount(1);
});

test("the sandbox confines the workspace and can be turned off", async ({
	page,
}) => {
	await openClean(page);
	const support = await page.evaluate(async () => {
		const response = await fetch("/api/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ language: "zig", scaffold: "minimal" }),
		});
		return ((await response.json()) as { sandboxSupport?: string })
			.sandboxSupport;
	});
	test.skip(
		support === "unsupported",
		"kernel without Landlock: nothing to enforce",
	);

	// Writing outside the session workspace: /tmp is the parent of every
	// workspace, so it needs no fixture on the host and is never granted.
	await replaceEditor(
		page,
		`const std = @import("std");

const probe = "/tmp/atomis-escape-probe.txt";

pub fn main(init: std.process.Init) void {
    if (std.Io.Dir.createFileAbsolute(init.io, probe, .{})) |file| {
        file.close(init.io);
        std.Io.Dir.deleteFileAbsolute(init.io, probe) catch {};
        std.debug.print("ESCAPED\\n", .{});
    } else |_| {
        std.debug.print("CONFINED\\n", .{});
    }
}
`,
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".output-list")).toContainText("CONFINED");

	// The same program escapes once the toggle is off.
	await setToggle(page, "Sandbox", false);
	await page.locator(".run-button").click();
	await expect(page.locator(".output-list")).toContainText("ESCAPED", {
		timeout: 60_000,
	});
	await setToggle(page, "Sandbox", true);
});

test("persistent workspaces keep their files across reloads", async ({
	page,
}) => {
	await openClean(page);
	const name = `spec-${Date.now()}`;

	// The sidebar is titled by the workspace, and the title is the switcher.
	await expect(page.locator(".workspace-bar")).toContainText("Scratch session");
	await page.locator(".workspace-bar").click();
	await page.getByLabel("New workspace name").fill(name);
	await page.getByRole("button", { name: "create" }).click();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".workspace-bar")).toContainText(name, {
		timeout: 30_000,
	});
	// The status bar keeps showing it too, for when the tree is hidden.
	await expect(page.locator(".branch-status")).toContainText(name);

	// A file created here must survive a full reload.
	await treeAction(page, "New file");
	await fillTreeDraft(page, "persisted.zig");
	await replaceEditor(page, "const kept = 41;\n");
	await expect(page.locator(".buffer-tab.active")).toContainText(
		"persisted.zig",
	);
	await page.waitForTimeout(500);
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await expect(page.locator(".branch-status")).toContainText(name);
	await expect(page.getByLabel("persisted.zig")).toBeVisible();
	await page.getByLabel("persisted.zig").click();
	// ZLS paints an inlay hint into this line once it has analysed the file
	// ("const kept: comptime_int = 41;"), and whether it has by now depends on
	// how warm the server is. Asserting across the gap does not work either —
	// Monaco renders the hint with its own spacing — so check the two ends
	// the file actually owns. What is under test is that it survived.
	await expect(page.locator(".view-lines")).toContainText("const kept");
	await expect(page.locator(".view-lines")).toContainText("41;");

	// Switching is an in-place swap, not a page reload: a marker planted on
	// window must survive it, and the runtime must still be live afterwards.
	await page.evaluate(() => {
		(window as object as { atomisSpaProbe?: number }).atomisSpaProbe = 7;
	});

	// A scratch session is a different, empty place…
	await page.locator(".workspace-bar").click();
	await page.getByText("Scratch session").click();
	await expect(page.locator(".branch-status")).toContainText("scratch", {
		timeout: 30_000,
	});
	await expect(page.getByLabel("persisted.zig")).toHaveCount(0);
	expect(
		await page.evaluate(
			() => (window as object as { atomisSpaProbe?: number }).atomisSpaProbe,
		),
	).toBe(7);
	// The rebuilt socket still runs code in the new session.
	await replaceEditor(page, 'const std = @import("std");\n\npub fn main() void {\n\tconst after_switch: i32 = 5;\n\t_ = after_switch;\n}\n');
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.getByText("5 : i32", { exact: true })).toBeVisible();

	// …and the workspace is still listed, with its files, until deleted.
	await page.locator(".workspace-bar").click();
	await page.locator(".workspace-open", { hasText: name }).click();
	await expect(page.getByLabel("persisted.zig")).toBeVisible({
		timeout: 30_000,
	});

	// Re-opening the ACTIVE workspace is a no-op: the live session (and the
	// inline values it produced) must survive the click.
	await replaceEditor(
		page,
		'const std = @import("std");\n\npub fn main() void {\n\tconst kept: i32 = 41;\n\t_ = kept;\n}\n',
	);
	await expect(page.getByText("41 : i32", { exact: true })).toBeVisible({
		timeout: 60_000,
	});
	const before = await page.locator(".branch-status b").textContent();
	await page.locator(".workspace-bar").click();
	await page.locator(".workspace-open", { hasText: name }).click();
	await expect(page.locator(".palette-overlay")).toHaveCount(0);
	await expect(page.locator(".branch-status b")).toHaveText(before ?? "");
	await expect(page.getByText("41 : i32", { exact: true })).toBeVisible();

	page.on("dialog", (dialog) => void dialog.accept());
	await treeAction(page, "Switch workspace…");
	await page.getByLabel(`Delete ${name}`).click();
	await expect(page.locator(".branch-status")).toContainText("scratch", {
		timeout: 30_000,
	});
});

test("dependencies install, persist and become importable", async ({
	page,
}) => {
	test.slow();
	await page.goto("/");
	await page.evaluate(() => {
		localStorage.clear();
		localStorage.setItem("atomis.language.v1", "rust");
		localStorage.setItem("atomis.scaffold.v1", "minimal");
	});
	await page.reload();
	await expect(page.locator(".file-tree")).toBeVisible();
	await setToggle(page, "Vim Mode", false);
	const available = await page.evaluate(async () => {
		const response = await fetch("/api/doctor");
		const body = (await response.json()) as {
			checks: { name: string; detected: string }[];
		};
		return !(
			body.checks.find((check) => check.name === "Rust cargo")?.detected ?? ""
		).includes("degraded");
	});
	test.skip(!available, "cargo not available");

	await page.locator(".term-menu-btn").click();
	await page.getByRole("menuitem", { name: /Dependencies/ }).click();
	await expect(page.locator(".term-view-label")).toHaveText("Dependencies");
	await expect(page.locator(".deps-list .empty-state")).toContainText(
		"Cargo.toml",
	);

	// Installing is the one moment Atomis goes online.
	await page.getByLabel("Add dependency").fill("uuid");
	await page.getByRole("button", { name: "install" }).click();
	await expect(page.locator(".deps-row")).toHaveCount(1, { timeout: 180_000 });
	await expect(page.locator(".deps-name")).toHaveText("uuid");
	await expect(page.locator(".term-view-label")).toHaveText("Dependencies 1");

	// The point of installing: the code can use it, compiled offline.
	await replaceEditor(
		page,
		"use uuid::Uuid;\n\nfn main() {\n\tlet id = Uuid::nil();\n\tprintln!(\"id {id}\");\n}\n",
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 180_000,
	});
	await page.locator(".term-menu-btn").click();
	await page.getByRole("menuitem", { name: "Output", exact: true }).click();
	await expect(page.locator(".output-list")).toContainText(
		"id 00000000-0000-0000-0000-000000000000",
	);

	// And removing takes it back out of the manifest.
	await page.locator(".term-menu-btn").click();
	await page.getByRole("menuitem", { name: /Dependencies/ }).click();
	await page.getByLabel("Remove uuid").click();
	await expect(page.locator(".deps-row")).toHaveCount(0, { timeout: 120_000 });
});

test("Allow network lets code call out while files stay confined", async ({
	page,
}) => {
	await openClean(page);
	const support = await page.evaluate(async () => {
		const response = await fetch("/api/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ language: "ts", scaffold: "minimal" }),
		});
		return ((await response.json()) as { sandboxSupport?: string })
			.sandboxSupport;
	});
	test.skip(
		support !== "files+network",
		"kernel without Landlock network rules",
	);

	// A local request keeps the test off the internet; the boundary being
	// tested is the sandbox, not the route.
	await page.getByRole("button", { name: "main.ts", exact: true }).click();
	await replaceEditor(
		page,
		'const probe = "/tmp/atomis-network-probe.txt";\nconst { writeFileSync } = await import("node:fs");\nlet reached = "denied";\ntry {\n\tconst response = await fetch("http://127.0.0.1:4317/api/health");\n\treached = String((await response.json()).ok);\n} catch {\n\treached = "denied";\n}\nlet wrote = "denied";\ntry {\n\twriteFileSync(probe, "x");\n\twrote = "escaped";\n} catch {\n\twrote = "denied";\n}\nconsole.log(`net:${reached} disk:${wrote}`);\n',
	);
	// Off by default: the program cannot reach the server at all.
	await expect(page.locator(".output-list")).toContainText(
		"net:denied disk:denied",
		{ timeout: 60_000 },
	);

	// With the toggle on, the call goes through — and the disk does not.
	await setToggle(page, "Allow network", true);
	await page.locator(".run-button").click();
	await expect(page.locator(".output-list")).toContainText(
		"net:true disk:denied",
		{ timeout: 60_000 },
	);
	await setToggle(page, "Allow network", false);
});

test("the caret starts in the editor, ready to type", async ({ page }) => {
	// Deliberately not openClean: opening the settings dialog and closing it
	// leaves the caret in the editor by itself, which would hide the bug.
	await page.goto("/");
	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	// Which element Monaco focuses is its business and has changed between
	// versions, so ask the question the user would: is the caret in there?
	await expect
		.poll(() =>
			page.evaluate(() =>
				Boolean(document.activeElement?.closest(".monaco-editor")),
			),
		)
		.toBe(true);
});

test("the toolbar, the tabs and the status bar can each be put away", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".editor-chrome")).toBeVisible();
	await expect(page.locator(".global-status")).toBeVisible();

	// One open file needs no tab strip; a second file brings it back.
	await setToggle(page, "Hide tabs for one file", true);
	await expect(page.locator(".tab-pill")).toHaveCount(0);
	await page.getByRole("button", { name: "main.py", exact: true }).click();
	await expect(page.locator(".tab-pill")).toBeVisible();
	await expect(page.getByRole("tab")).toHaveCount(2);

	await setToggle(page, "Status bar", false);
	await expect(page.locator(".global-status")).toHaveCount(0);

	// Turning the toolbar off takes the settings gear with it, which is what
	// the palette command is for.
	await setToggle(page, "Toolbar", false);
	await expect(page.locator(".editor-chrome")).toHaveCount(0);
	await expect(page.locator(".chrome-icon")).toHaveCount(0);

	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.locator(".palette")).toBeVisible();
	await page.locator(".palette input").fill(">settings");
	await page.getByText("Open settings").click();
	await expect(page.locator(".settings-modal")).toBeVisible();

	// The choices survive a reload, and the editor is still usable without
	// any furniture around it.
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(page.locator(".monaco-editor")).toBeVisible();
	await expect(page.locator(".editor-chrome")).toHaveCount(0);
	await expect(page.locator(".global-status")).toHaveCount(0);

	await page.keyboard.press("ControlOrMeta+,");
	await expect(page.locator(".settings-modal")).toBeVisible();
	await page.keyboard.press("Escape");
});
