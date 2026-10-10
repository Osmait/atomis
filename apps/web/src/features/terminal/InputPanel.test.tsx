// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputPanel, lineCountLabel } from "./InputPanel.js";

afterEach(cleanup);

describe("InputPanel", () => {
	it("counts lines whether or not the last one ends in a newline", () => {
		expect(lineCountLabel("")).toBe("empty");
		expect(lineCountLabel("42")).toBe("1 line");
		expect(lineCountLabel("3\n5 7 9\n")).toBe("2 lines");
		expect(lineCountLabel("3\n5 7 9")).toBe("2 lines");
	});

	it("edits and clears the input", () => {
		const onChange = vi.fn();
		render(<InputPanel mode="text" onChange={onChange} onModeChange={vi.fn()} value={"3\n5 7 9\n"} />);
		expect(screen.getByText("2 lines")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Program input"), {
			target: { value: "4\n" },
		});
		expect(onChange).toHaveBeenLastCalledWith("4\n");
		fireEvent.click(screen.getByText("Clear"));
		expect(onChange).toHaveBeenLastCalledWith("");
	});

	it("says when the input is too large to send", () => {
		render(<InputPanel mode="text" onChange={vi.fn()} onModeChange={vi.fn()} value={"x".repeat(512 * 1024 + 1)} />);
		expect(screen.getByRole("alert").textContent).toContain("Too large");
		expect(
			screen.getByLabelText("Program input").getAttribute("aria-invalid"),
		).toBe("true");
	});

	it("switches where a Run reads stdin from, and says what each means", () => {
		const onModeChange = vi.fn();
		render(<InputPanel mode="text" onChange={vi.fn()} onModeChange={onModeChange} value="" />);
		expect(
			screen.getByRole("radio", { name: "This text" }).getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(screen.getByRole("radio", { name: "Typed in the terminal" }));
		expect(onModeChange).toHaveBeenCalledWith("terminal");
		cleanup();
		render(<InputPanel mode="terminal" onChange={vi.fn()} onModeChange={vi.fn()} value="" />);
		expect(screen.getByText(/Run waits for what you type/)).toBeTruthy();
	});
});
