// @vitest-environment jsdom
// The socket hook's offline contract: what is typed while the socket is
// away must reach the server after the reattach — before this queue, only
// the entry file was re-pushed and every other file's edits (and every
// file created offline) were silently gone, so the next run compiled code
// the editor no longer showed.
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CreateSessionResponse } from "@atomis/protocol";
import { useRuntimeSocket } from "./useRuntimeSocket.js";

interface SentMessage {
	type?: string;
	path?: string;
	source?: string;
	baseRevision?: number;
	version?: number;
}

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	readonly OPEN = 1;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	listeners = new Map<string, ((event: object) => void)[]>();
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	addEventListener(name: string, handler: (event: object) => void): void {
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
	disconnects(): void {
		this.readyState = 3;
		for (const handler of this.listeners.get("close") ?? []) handler({});
	}
	receives(event: object): void {
		for (const handler of this.listeners.get("message") ?? []) handler({data: JSON.stringify(event)});
	}
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function mount(onSessionExpired?: (unsaved: boolean) => Promise<void>) {
	vi.stubGlobal("WebSocket", FakeWebSocket as never);
	FakeWebSocket.instances = [];
	const session = {
		sessionId: "s".repeat(32),
		authToken: "t",
		initialSource: "initial",
	} as never as CreateSessionResponse;
	const files = [{ path: "main.zig", uri: "u", source: "edited" }];
	const revisionRef = { current: undefined as number | undefined };
	const options = {
			session,
			handleRuntimeEvent: () => {},
			settingsRef: { current: { autoRun: true } as never },
			filesRef: { current: files as never },
			entryRef: { current: "main.zig" },
			versionRef: { current: 1 },
			revisionRef,
			lspClientsRef: { current: {} },
			setStatus: () => {},
			...(onSessionExpired ? { onSessionExpired } : {}),
	};
	const rendered = renderHook(() => useRuntimeSocket(options));
	return { rendered, revisionRef, socket: () => FakeWebSocket.instances.at(-1) };
}

const parsed = (socket: FakeWebSocket | undefined) =>
	(socket?.sent ?? []).map((raw) => JSON.parse(raw) as SentMessage);

describe("useRuntimeSocket", () => {
	test("interleaved offline A-B-A edits flush in increasing version order", () => {
		const { rendered, socket } = mount();
		act(() => {
			for (const [version, path, source] of [[3, "main.zig", "A1"], [4, "helper.zig", "B1"], [5, "main.zig", "A2"]])
				rendered.result.current.sendRuntime({ type: "document.update", version, path, source });
		});
		act(() => socket()?.opens());
		expect(parsed(socket()).filter(m => m.type === "document.update").map(m => [m.version, m.source])).toEqual([[4, "B1"], [5, "A2"]]);
	});

	test("coalescing never crosses a rename or delete/create boundary", () => {
		const { rendered, socket } = mount();
		act(() => {
			for (const message of [
				{ type: "document.update", version: 2, path: "helper.zig", source: "before rename" },
				{ type: "file.rename", version: 3, path: "helper.zig", newPath: "renamed.zig" },
				{ type: "file.create", version: 4, path: "helper.zig", source: "new file" },
				{ type: "document.update", version: 5, path: "helper.zig", source: "new text" },
			]) rendered.result.current.sendRuntime(message);
		});
		act(() => socket()?.opens());
		expect(parsed(socket()).filter(m => m.path === "helper.zig").map(m => m.version)).toEqual([2, 3, 4, 5]);
	});

	test("an expired session triggers recovery with unacknowledged edits", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({status: 404}));
		const recover = vi.fn().mockResolvedValue(undefined);
		const { rendered, socket } = mount(recover);
		act(() => socket()?.opens());
		act(() => rendered.result.current.sendRuntime({type: "document.update", version: 9, path: "helper.zig", source: "keep me"}));
		act(() => socket()?.disconnects());
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(recover).toHaveBeenCalledWith(true);
	});

	test("acknowledged edits do not require a recovery copy", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({status: 404}));
		const recover = vi.fn().mockResolvedValue(undefined);
		const { socket } = mount(recover);
		act(() => socket()?.opens());
		act(() => socket()?.receives({type: "document.saved", documentVersion: 2}));
		act(() => socket()?.disconnects());
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(recover).toHaveBeenCalledWith(false);
	});

	test("a network failure retries instead of treating the session as expired", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const recover = vi.fn().mockResolvedValue(undefined);
		const { socket } = mount(recover);
		act(() => socket()?.opens());
		act(() => socket()?.disconnects());
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(recover).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
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
