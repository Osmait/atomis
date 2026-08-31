// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

function Bomb(): never {
	throw new Error("boom en render");
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
	it("renders its children while nothing throws", () => {
		render(
			<ErrorBoundary>
				<p>vivo</p>
			</ErrorBoundary>,
		);
		expect(screen.getByText("vivo")).toBeDefined();
	});

	it("replaces a crashed tree with the recovery screen", () => {
		// React logs the boundary-caught error; keep the test output clean.
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		render(
			<ErrorBoundary>
				<Bomb />
			</ErrorBoundary>,
		);
		expect(screen.getByText("boom en render")).toBeDefined();
		expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
	});
});
