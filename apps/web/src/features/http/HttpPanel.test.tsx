// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpPanel } from "./HttpPanel.js";
import { EMPTY_DRAFT, type HttpDraft, type HttpExchange } from "./httpClient.js";
import type { Endpoint } from "./endpoints.js";

afterEach(cleanup);

const endpoints: Endpoint[] = [
	{ method: "GET", path: "/items/:id", file: "main.ts", line: 4, via: "route" },
	{ method: "ANY", path: "/health", file: "main.ts", line: 9, via: "node:http" },
];

function mount(overrides: Partial<React.ComponentProps<typeof HttpPanel>> = {}) {
	const handlers = {
		onServeChange: vi.fn(),
		onDraftChange: vi.fn(),
		onSend: vi.fn(),
		onPick: vi.fn(),
		onJump: vi.fn(),
	};
	render(
		<HttpPanel
			draft={{ ...EMPTY_DRAFT, method: "POST" }}
			endpoints={endpoints}
			history={[]}
			port={21000}
			sending={false}
			serve={true}
			serving={true}
			{...handlers}
			{...overrides}
		/>,
	);
	return handlers;
}

describe("HttpPanel", () => {
	it("says where the server listens and switches server mode", () => {
		const handlers = mount();
		expect(screen.getByText("● serving on PORT 21000")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Run as a server"));
		expect(handlers.onServeChange).toHaveBeenCalledWith(false);
	});

	it("fills the request from an endpoint, with its parameters made sendable", () => {
		const handlers = mount();
		fireEvent.click(screen.getByRole("button", { name: "GET /items/:id" }));
		expect(handlers.onDraftChange).toHaveBeenLastCalledWith<[HttpDraft]>(
			expect.objectContaining({ method: "GET", path: "/items/1" }),
		);
		// ANY: the code takes any method, so the chosen one stays.
		fireEvent.click(screen.getByRole("button", { name: "ANY /health" }));
		expect(handlers.onDraftChange).toHaveBeenLastCalledWith<[HttpDraft]>(
			expect.objectContaining({ method: "POST", path: "/health" }),
		);
	});

	it("jumps to where an endpoint is declared", () => {
		const handlers = mount();
		fireEvent.click(screen.getByText("main.ts:9"));
		expect(handlers.onJump).toHaveBeenCalledWith("main.ts", 9);
	});

	it("shows the last answer an endpoint got", () => {
		const answered: HttpExchange = {
			id: 1,
			request: { method: "GET", path: "/items/1?x=1", headers: "", body: "" },
			at: 0,
			ms: 3,
			status: 404,
			headers: [],
			body: "",
			bytes: 0,
		};
		mount({ history: [answered] });
		const row = screen.getByRole("button", { name: "GET /items/:id" });
		expect(row.textContent).toContain("404");
	});

	it("explains what it looks for when it finds nothing", () => {
		mount({ endpoints: [] });
		expect(screen.getByText(/None found in the code yet/)).toBeTruthy();
	});
});
