// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoPicker } from "./DemoPicker.js";
import type { DemoKind } from "./catalog.js";

afterEach(cleanup);

const kinds: DemoKind[] = [
	{ id: "repl", title: "Calculator REPL", summary: "Reads input", stdinMode: "terminal", sources: { py: "print(1)", rust: "fn main() {}" } },
	{ id: "fib", title: "Fibonacci", summary: "Recursion", sources: { py: "print(2)" } },
];

function mount(runnable: (language: string) => boolean = () => true) {
	const onOpen = vi.fn();
	const onClose = vi.fn();
	render(<DemoPicker kinds={kinds} onClose={onClose} onOpen={onOpen} runnable={runnable} />);
	return { onOpen, onClose };
}

describe("DemoPicker", () => {
	it("lists each kind with the languages it comes in, and opens one", () => {
		const { onOpen } = mount();
		expect(screen.getByText("Calculator REPL")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Calculator REPL in Rust"));
		expect(onOpen).toHaveBeenCalledWith(
			expect.objectContaining({ id: "repl-rust", language: "rust" }),
		);
	});

	it("filters by kind and by language", () => {
		mount();
		fireEvent.change(screen.getByLabelText("Filter demos"), { target: { value: "rust" } });
		expect(screen.queryByText("Fibonacci")).toBeNull();
		expect(screen.queryByLabelText("Calculator REPL in Python")).toBeNull();
		fireEvent.change(screen.getByLabelText("Filter demos"), { target: { value: "zzz" } });
		expect(screen.getByText("No demo matches.")).toBeTruthy();
	});

	it("shows a language this server cannot run, switched off", () => {
		mount((language) => language !== "rust");
		const rust = screen.getByLabelText("Calculator REPL in Rust") as HTMLButtonElement;
		expect(rust.disabled).toBe(true);
	});

	it("opens the first runnable match on Enter, and closes on Escape", () => {
		const { onOpen, onClose } = mount((language) => language !== "py");
		fireEvent.keyDown(screen.getByLabelText("Filter demos"), { key: "Enter" });
		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "repl-rust" }));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});
});
