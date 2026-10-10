// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAction, ConfirmHost } from "./confirm.js";

afterEach(cleanup);

function ask(): Promise<boolean> {
	let answer!: Promise<boolean>;
	act(() => {
		answer = confirmAction({
			title: "Delete src/notes.txt?",
			message: "This cannot be undone.",
			confirmLabel: "Delete file",
		});
	});
	return answer;
}

describe("confirmAction", () => {
	it("shows nothing until asked", () => {
		render(<ConfirmHost />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("resolves true on the confirm button and closes", async () => {
		render(<ConfirmHost />);
		const answer = ask();
		const dialog = screen.getByRole("alertdialog", { name: "Delete src/notes.txt?" });
		expect(dialog.textContent).toContain("This cannot be undone.");
		// Focus starts on the action, so Enter answers it as window.confirm did.
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete file" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
		await expect(answer).resolves.toBe(true);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it.each([
		["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
		["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
		[
			"a click on the backdrop",
			() => fireEvent.click(document.querySelector(".confirm-overlay")!),
		],
	])("resolves false on %s", async (_, dismiss) => {
		render(<ConfirmHost />);
		const answer = ask();
		act(dismiss);
		await expect(answer).resolves.toBe(false);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("keeps Escape from also closing what it was opened over", async () => {
		const underneath = vi.fn();
		window.addEventListener("keydown", underneath);
		try {
			render(<ConfirmHost />);
			const answer = ask();
			act(() => {
				fireEvent.keyDown(window, { key: "Escape" });
			});
			await expect(answer).resolves.toBe(false);
			expect(underneath).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("keydown", underneath);
		}
	});

	it("cancels an unanswered question when another is asked", async () => {
		render(<ConfirmHost />);
		const first = ask();
		let second!: Promise<boolean>;
		act(() => {
			second = confirmAction({ title: "Clear the workspace?", confirmLabel: "Clear" });
		});
		await expect(first).resolves.toBe(false);
		expect(screen.getByRole("alertdialog", { name: "Clear the workspace?" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		await expect(second).resolves.toBe(true);
	});

	it("gives focus back to where it was", async () => {
		render(
			<>
				<button>editor</button>
				<ConfirmHost />
			</>,
		);
		const editor = screen.getByRole("button", { name: "editor" });
		editor.focus();
		const answer = ask();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await answer;
		expect(document.activeElement).toBe(editor);
	});
});
