// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StdinLine } from "./StdinLine.js";

afterEach(cleanup);

function mount() {
	const onSend = vi.fn();
	const onEof = vi.fn();
	render(<StdinLine onEof={onEof} onSend={onSend} />);
	const field = screen.getByLabelText("Input for the running program");
	return { onSend, onEof, field };
}

describe("StdinLine", () => {
	it("takes focus: the program is waiting on it", () => {
		const { field } = mount();
		expect(document.activeElement).toBe(field);
	});

	it("sends a line with its newline on Enter, then clears", () => {
		const { onSend, field } = mount();
		fireEvent.change(field, { target: { value: "42" } });
		fireEvent.submit(field.closest("form") as HTMLFormElement);
		expect(onSend).toHaveBeenCalledWith("42\n");
		expect((field as HTMLInputElement).value).toBe("");
	});

	it("ends the input with Ctrl+D or the EOF button, after what is typed", () => {
		const { onEof, field } = mount();
		fireEvent.change(field, { target: { value: "last" } });
		fireEvent.keyDown(field, { key: "d", ctrlKey: true });
		expect(onEof).toHaveBeenLastCalledWith("last");
		fireEvent.click(screen.getByRole("button", { name: "EOF" }));
		expect(onEof).toHaveBeenLastCalledWith("");
	});
});
