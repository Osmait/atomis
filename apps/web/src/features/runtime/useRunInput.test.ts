// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionResponse, RuntimeClientMessage } from "@atomis/protocol";
import { useRunInput } from "./useRunInput.js";

const session = (id: string, input = ""): CreateSessionResponse =>
	({ sessionId: id.repeat(32), input }) as object as CreateSessionResponse;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function mount(initial: CreateSessionResponse) {
	const sent: RuntimeClientMessage[] = [];
	const rendered = renderHook(
		({ current }) => useRunInput(current, (message) => sent.push(message)),
		{ initialProps: { current: initial } },
	);
	return { rendered, sent };
}

describe("useRunInput", () => {
	it("starts from the session's saved input", () => {
		const { rendered } = mount(session("a", "saved\n"));
		expect(rendered.result.current.input).toBe("saved\n");
	});

	it("sends once typing pauses, not on every keystroke", () => {
		const { rendered, sent } = mount(session("a"));
		act(() => rendered.result.current.setInput("4"));
		act(() => rendered.result.current.setInput("42"));
		expect(sent).toHaveLength(0);
		act(() => vi.advanceTimersByTime(300));
		expect(sent).toEqual([{ type: "input.update", sessionId: "a".repeat(32), text: "42" }]);
	});

	it("flush sends what is pending at once, and only once", () => {
		const { rendered, sent } = mount(session("a"));
		act(() => rendered.result.current.setInput("7\n"));
		act(() => rendered.result.current.flushInput());
		expect(sent).toHaveLength(1);
		act(() => vi.advanceTimersByTime(1000));
		act(() => rendered.result.current.flushInput());
		expect(sent).toHaveLength(1);
	});

	it("keeps an oversized input local", () => {
		const { rendered, sent } = mount(session("a"));
		act(() => rendered.result.current.setInput("x".repeat(512 * 1024 + 1)));
		act(() => rendered.result.current.flushInput());
		expect(sent).toHaveLength(0);
	});

	it("drops a pending edit when the session changes, and takes the new one's input", () => {
		const { rendered, sent } = mount(session("a"));
		act(() => rendered.result.current.setInput("for a"));
		rendered.rerender({ current: session("b", "b's input") });
		act(() => vi.advanceTimersByTime(1000));
		// Sent under the old sessionId, the server would close the socket.
		expect(sent).toHaveLength(0);
		expect(rendered.result.current.input).toBe("b's input");
	});
});
