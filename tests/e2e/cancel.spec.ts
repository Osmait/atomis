import { expect, test } from "@playwright/test";
import { openClean, replaceEditor } from "./helpers.js";
import { resetPreferences } from "./reset.js";

test.beforeEach(async ({ request, baseURL }) => {
	await resetPreferences(request, baseURL);
});

/**
 * The header feature nothing else covers: a run that will never finish can
 * be stopped by hand. The Run button doubles as the cancel control — while
 * a pipeline stage is active it turns into Stop (`.run-button.running`) —
 * and cancelling must land the UI in `cancelled`, not in an error, and must
 * leave the session healthy enough that the next run just works.
 */
test("a hung run can be cancelled and the session keeps working", async ({
	page,
}) => {
	await openClean(page);
	await expect(page.locator(".state-succeeded")).toBeVisible();

	// An honest infinite loop: without intervention this would sit busy
	// until the server's own timeout (~20s), which is what the spec about
	// timed_out covers. Here we never let it get that far.
	await replaceEditor(page, "pub fn main() void { while (true) {} }\n");

	// Wait for the program itself to be running (not just compiling), so the
	// cancel exercises the kill of a live process. Zig may take a while on a
	// cold cache.
	await expect(page.locator(".run-state.state-running")).toBeVisible({
		timeout: 40_000,
	});
	const stopButton = page.locator(".run-button.running");
	await expect(stopButton).toBeVisible();
	await expect(stopButton).toHaveAttribute("aria-label", "Stop");
	await stopButton.click();

	// The server answers run.cancel with an explicit `cancelled` state —
	// distinct from timed_out and from the error states.
	await expect(page.locator(".run-state.state-cancelled")).toBeVisible();
	await expect(page.locator(".run-button.running")).toHaveCount(0);

	// And the session is not poisoned: a normal edit runs to completion.
	await replaceEditor(
		page,
		"pub fn main() void {\n    const after_cancel: i32 = 6;\n    _ = after_cancel;\n}\n",
	);
	await expect(page.locator(".state-succeeded")).toBeVisible({
		timeout: 40_000,
	});
	await expect(page.getByText("6 : i32", { exact: true })).toBeVisible();
});
