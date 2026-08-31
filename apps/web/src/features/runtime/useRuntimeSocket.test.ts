// @vitest-environment jsdom
// The socket hook's offline contract: what is typed while the socket is
// away must reach the server after the reattach — before this queue, only
// the entry file was re-pushed and every other file's edits (and every
// file created offline) were silently gone, so the next run compiled code
// the editor no longer showed.
import { describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CreateSessionResponse } from "@atomis/protocol";
import { useRuntimeSocket } from "./useRuntimeSocket.js";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	readonly OPEN = 1;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	listeners = new Map<string, ((event: unknown) => void)[]>();
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	addEventListener(name: string, handler: (event: unknown) => void): void {
		const bucket = this.listeners.get(name) ?? [];
		bucket.push(handler);
		this.listeners.set(name, bucket);
	}
	send(payload: string): void {
		this.sent.push(payload);
	}
	close(): void {
		this.readyState = 3;
	}
	opens(): void {
		this.readyState = FakeWebSocket.OPEN;
		for (const handler of this.listeners.get("open") ?? []) handler({});
	}
}

function mount() {
	vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
	FakeWebSocket.instances = [];
	const session = {
		sessionId: "s".repeat(32),
		authToken: "t",
		initialSource: "initial",
	} as unknown as CreateSessionResponse;
	const files = [{ path: "main.zig", uri: "u", source: "edited" }];
	const revisionRef = { current: undefined as number | undefined };
	const rendered = renderHook(() =>
		useRuntimeSocket({
			session,
			handleRuntimeEvent: () => {},
			settingsRef: { current: { autoRun: true } as never },
			filesRef: { current: files as never },
			entryRef: { current: "main.zig" },
			versionRef: { current: 1 },
			revisionRef,
			lspClientsRef: { current: {} },
			setStatus: () => {},
		}),
	);
	return { rendered, revisionRef, socket: () => FakeWebSocket.instances.at(-1) };
}

const parsed = (socket: FakeWebSocket | undefined) =>
	(socket?.sent ?? []).map((raw) => JSON.parse(raw) as Record<string, unknown>);

describe("useRuntimeSocket", () => {
	test("messages sent while connecting queue and flush on open, in order", () => {
		const { rendered, socket } = mount();
		act(() => {
			rendered.result.current.sendRuntime({
				type: "file.create",
				sessionId: "x",
				version: 2,
				path: "utils.zig",
				source: "a",
			});
			rendered.result.current.sendRuntime({
				type: "document.update",
				sessionId: "x",
				version: 3,
				path: "utils.zig",
				source: "b",
			});
		});
		expect(socket()?.sent ?? []).toHaveLength(0);
		act(() => socket()?.opens());
		const messages = parsed(socket());
		const kinds = messages.map((message) => message.type);
		// settings first, then the offline work in the order it happened.
		expect(kinds.indexOf("file.create")).toBeGreaterThan(
			kinds.indexOf("settings.update"),
		);
		expect(kinds.indexOf("document.update")).toBeGreaterThan(
			kinds.indexOf("file.create"),
		);
	});

	test("offline edits to one file coalesce to the newest", () => {
		const { rendered, socket } = mount();
		act(() => {
			for (const source of ["v1", "v2", "v3"])
				rendered.result.current.sendRuntime({
					type: "document.update",
					sessionId: "x",
					version: 5,
					path: "utils.zig",
					source,
				});
		});
		act(() => socket()?.opens());
		const updates = parsed(socket()).filter(
			(message) => message.type === "document.update" && message.path === "utils.zig",
		);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.source).toBe("v3");
	});

	test("moments do not replay: run and cancel are dropped while away", () => {
		const { rendered, socket } = mount();
		act(() => {
			rendered.result.current.sendRuntime({ type: "run.request", version: 1 });
			rendered.result.current.sendRuntime({ type: "run.cancel" });
		});
		act(() => socket()?.opens());
		const kinds = parsed(socket()).map((message) => message.type);
		expect(kinds).not.toContain("run.request");
		expect(kinds).not.toContain("run.cancel");
	});

	test("the entry push carries the shared-workspace base revision", () => {
		const { rendered, revisionRef, socket } = mount();
		revisionRef.current = 17;
		expect(rendered.result.current).toBeDefined();
		act(() => socket()?.opens());
		const update = parsed(socket()).find(
			(message) => message.type === "document.update",
		);
		// Without it the server skips the conflict check entirely and the
		// reconnect overwrites whatever a peer wrote in the meantime.
		expect(update?.baseRevision).toBe(17);
	});

	test("an oversized source is refused instead of poisoning the socket", () => {
		const { rendered, socket } = mount();
		act(() => socket()?.opens());
		const before = socket()?.sent.length ?? 0;
		act(() => {
			rendered.result.current.sendRuntime({
				type: "document.update",
				sessionId: "x",
				version: 9,
				path: "main.zig",
				source: "x".repeat(1024 * 1024 + 1),
			});
		});
		expect(socket()?.sent.length).toBe(before);
	});
});
