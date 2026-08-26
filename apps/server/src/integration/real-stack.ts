import WebSocket from "ws";
import type { CreateSessionResponse } from "@ziglive/protocol";

function parseJson<T>(raw: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(
			`invalid JSON from real stack: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const base = process.env.ZIGLIVE_TEST_URL ?? "http://127.0.0.1:4317";
const origin = base;
const response = await fetch(`${base}/api/sessions`, {
	method: "POST",
	headers: { origin, "content-type": "application/json" },
	body: "{}",
});
if (!response.ok) throw new Error(`session failed: ${response.status}`);
const session = (await response.json()) as CreateSessionResponse;
const query = new URLSearchParams({
	sessionId: session.sessionId,
	token: session.authToken,
});
const wsBase = base.replace(/^http/, "ws");
const runtime = new WebSocket(`${wsBase}/ws/runtime?${query}`, { origin });
const lsp = new WebSocket(`${wsBase}/ws/lsp?${query}`, { origin });
const previews = new Map<string, string>();
const trace: string[] = [];
let runtimeDone = false;
let lspDone = false;
const timeout = setTimeout(() => {
	throw new Error(
		`real stack timeout; probes=${JSON.stringify([...previews])}, lsp=${lspDone}`,
	);
}, 30_000);

runtime.on("message", (data) => {
	const event = parseJson<{
		type: string;
		name?: string;
		preview?: string;
		state?: string;
		details?: string;
		chunk?: string;
		result?: { exitCode?: number | null; reason?: string };
	}>(data.toString());
	trace.push(
		event.type === "output"
			? `${event.type}:${event.chunk ?? ""}`
			: `${event.type}:${event.state ?? event.result?.reason ?? ""}`,
	);
	if (event.type === "probe_value" && event.name && event.preview)
		previews.set(event.name, event.preview);
	if (event.type === "server.error")
		throw new Error(event.details ?? "server error");
	if (event.type === "run.finished") {
		if (event.result?.exitCode !== 0)
			throw new Error(
				`run failed: ${JSON.stringify(event.result)}\n${trace.join("\n")}`,
			);
		for (const [name, expected] of [
			["price", "40"],
			["tax", "3"],
			["total", "43"],
		] as const) {
			if (previews.get(name) !== expected)
				throw new Error(
					`expected ${name}=${expected}, got ${previews.get(name)}`,
				);
		}
		if (
			!previews.get("values")?.includes("40") ||
			!previews.get("values")?.includes("43")
		)
			throw new Error(`unexpected array preview ${previews.get("values")}`);
		runtimeDone = true;
		finish();
	}
});

lsp.on("open", () =>
	lsp.send(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				processId: null,
				rootUri: session.documentUri.slice(
					0,
					session.documentUri.lastIndexOf("/"),
				),
				workspaceFolders: [
					{
						uri: session.documentUri.slice(
							0,
							session.documentUri.lastIndexOf("/"),
						),
						name: "test",
					},
				],
				capabilities: {
					textDocument: { completion: {}, hover: {}, publishDiagnostics: {} },
				},
			},
		}),
	),
);
lsp.on("message", (data) => {
	const message = parseJson<{
		id?: number;
		result?: {
			capabilities?: { completionProvider?: unknown; hoverProvider?: unknown };
		};
	}>(data.toString());
	if (message.id === 1) {
		if (
			!message.result?.capabilities?.completionProvider ||
			!message.result.capabilities.hoverProvider
		)
			throw new Error("ZLS did not advertise completion and hover");
		lsp.send(
			JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
		);
		lsp.send(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "textDocument/didOpen",
				params: {
					textDocument: {
						uri: session.documentUri,
						languageId: "zig",
						version: 1,
						text: session.initialSource,
					},
				},
			}),
		);
		lspDone = true;
		finish();
	}
});

function finish(): void {
	if (!runtimeDone || !lspDone) return;
	clearTimeout(timeout);
	process.stdout.write(
		`${JSON.stringify({ ok: true, probes: Object.fromEntries(previews), zig: session.zigVersion, zls: session.zlsVersion })}\n`,
	);
	runtime.close();
	lsp.close();
}
