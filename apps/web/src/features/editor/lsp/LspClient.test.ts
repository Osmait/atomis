// @vitest-environment jsdom
// The LSP client against a dead or slow server: a request must never hang
// forever (its promise resolved every later request into a pile-up), a
// closing socket must answer every pending caller, and no document
// notification may reach the server before the initialize handshake is done.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { LspClient } from "./LspClient.js";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	listeners = new Map<string, ((event: { data?: string }) => void)[]>();
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	addEventListener(
		name: string,
		handler: (event: { data?: string }) => void,
	): void {
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
	receives(message: object): void {
		for (const handler of this.listeners.get("message") ?? [])
			handler({ data: JSON.stringify(message) });
	}
	/** The server-side close: readyState drops and the close event fires. */
	drops(): void {
		this.readyState = 3;
		for (const handler of this.listeners.get("close") ?? []) handler({});
	}
}

/** The one hover provider shape these tests drive. */
interface CapturedHoverProvider {
	provideHover: (
		model: Monaco.editor.ITextModel,
		at: { lineNumber: number; column: number },
	) => Promise<{ contents: { value: string }[] } | null>;
}

const hoverProviders: CapturedHoverProvider[] = [];
const disposable = { dispose: (): void => undefined };
const fakeMonaco = {
	languages: {
		registerCompletionItemProvider: () => disposable,
		registerHoverProvider: (_id: string, provider: CapturedHoverProvider) => {
			hoverProviders.push(provider);
			return disposable;
		},
		registerDefinitionProvider: () => disposable,
		registerReferenceProvider: () => disposable,
		registerDocumentFormattingEditProvider: () => disposable,
		registerDocumentSemanticTokensProvider: () => disposable,
		registerInlayHintsProvider: () => disposable,
		registerCodeActionProvider: () => disposable,
	},
	editor: {
		getModel: () => null,
		setModelMarkers: () => undefined,
	},
	Uri: { parse: (value: string) => ({ toString: () => value }) },
} as object as typeof Monaco;

function fakeModel(uri: string, text: string): Monaco.editor.ITextModel {
	return {
		uri: { toString: () => uri },
		getValue: () => text,
	} as object as Monaco.editor.ITextModel;
}

/** Lets the async initialize continuation run to completion. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

const sentMessages = (
	socket: FakeWebSocket,
): { id?: number; method?: string; params?: { textDocument?: { uri?: string; version?: number; text?: string } } }[] =>
	socket.sent.map(
		(raw) =>
			JSON.parse(raw) as {
				id?: number;
				method?: string;
				params?: {
					textDocument?: { uri?: string; version?: number; text?: string };
				};
			},
	);

function connectClient() {
	const model = fakeModel("file:///ws/src/main.zig", "const x = 1;");
	const statuses: string[] = [];
	const client = new LspClient(
		fakeMonaco,
		model,
		"file:///ws/src",
		() => undefined,
		() => undefined,
		(status) => statuses.push(status),
		"zig",
		"zls",
	);
	client.connect("ws://fake/lsp", 1);
	const socket = FakeWebSocket.instances.at(-1)!;
	const completeHandshake = async (capabilities?: object): Promise<void> => {
		const initialize = sentMessages(socket).find(
			(message) => message.method === "initialize",
		);
		socket.receives({
			jsonrpc: "2.0",
			id: initialize?.id,
			result: { capabilities: capabilities ?? { hoverProvider: true } },
		});
		await settle();
	};
	return { client, model, socket, statuses, completeHandshake };
}

const hover = (): Promise<{ contents: { value: string }[] } | null> =>
	hoverProviders.at(-1)!.provideHover(
		fakeModel("file:///ws/src/main.zig", ""),
		{ lineNumber: 1, column: 1 },
	);

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeWebSocket as object as typeof WebSocket);
	FakeWebSocket.instances = [];
	hoverProviders.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("LspClient", () => {
	it("no document notification precedes the initialize handshake", async () => {
		const { client, socket, completeHandshake } = connectClient();
		socket.opens();
		const extra = fakeModel("file:///ws/src/util.zig", "the latest text");
		// An edit arriving between the socket opening and initialize
		// completing: the server has seen no didOpen yet, so a didChange
		// now would describe a document it never opened.
		client.change(extra, 2, "the latest text");
		const preHandshake = sentMessages(socket).map((message) => message.method);
		expect(preHandshake).toEqual(["initialize"]);

		await completeHandshake();
		const methods = sentMessages(socket).map((message) => message.method);
		expect(methods).not.toContain("textDocument/didChange");
		const opens = sentMessages(socket).filter(
			(message) => message.method === "textDocument/didOpen",
		);
		// Both documents opened, and the queued one carries its latest text.
		expect(opens.map((message) => message.params?.textDocument?.uri)).toEqual([
			"file:///ws/src/main.zig",
			"file:///ws/src/util.zig",
		]);
		expect(opens[1]?.params?.textDocument?.text).toBe("the latest text");

		// After the handshake, changes flow as didChange with growing versions.
		client.change(extra, 3, "v3");
		client.change(extra, 3, "v3 again");
		const changes = sentMessages(socket).filter(
			(message) => message.method === "textDocument/didChange",
		);
		expect(changes).toHaveLength(2);
		const versions = changes.map(
			(message) => message.params?.textDocument?.version ?? 0,
		);
		expect(versions[1]).toBeGreaterThan(versions[0]!);
	});

	it("a request nobody answers resolves null after the timeout", async () => {
		vi.useFakeTimers();
		const { socket, completeHandshake } = connectClient();
		socket.opens();
		await completeHandshake();

		const pendingHover = hover();
		const sentBefore = socket.sent.length;
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(pendingHover).resolves.toBeNull();
		// And the slot is free again: the next request goes on the wire.
		void hover();
		expect(socket.sent.length).toBe(sentBefore + 1);
	});

	it("a socket closing mid-request answers every pending caller", async () => {
		const { socket, completeHandshake } = connectClient();
		socket.opens();
		await completeHandshake();

		const pendingHover = hover();
		socket.drops();
		await expect(pendingHover).resolves.toBeNull();

		// Dead client: later requests short-circuit without touching the wire.
		const sentBefore = socket.sent.length;
		await expect(hover()).resolves.toBeNull();
		expect(socket.sent.length).toBe(sentBefore);
	});

	it("notifies its owner exactly once when the socket closes", async () => {
		const { client, socket, completeHandshake } = connectClient();
		socket.opens();
		await completeHandshake();
		let closures = 0;
		client.onClose = () => {
			closures += 1;
		};
		socket.drops();
		socket.drops();
		expect(closures).toBe(1);
	});

	it("dispose does not re-notify the owner through onClose", async () => {
		const { client, socket, completeHandshake } = connectClient();
		socket.opens();
		await completeHandshake();
		let closures = 0;
		client.onClose = () => {
			closures += 1;
		};
		client.dispose();
		// A real socket fires its close event after dispose closed it.
		socket.drops();
		expect(closures).toBe(0);
	});
});
