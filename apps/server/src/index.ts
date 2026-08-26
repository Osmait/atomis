import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import {
	MAX_RUNTIME_MESSAGE_BYTES,
	MAX_SOURCE_BYTES,
	runtimeClientMessageSchema,
	type RuntimeServerEvent,
} from "@ziglive/protocol";
import { CompilerRunner } from "./compiler/CompilerRunner.js";
import { RunScheduler } from "./compiler/RunScheduler.js";
import { runDoctor } from "./doctor.js";
import { LspProxy } from "./lsp/LspProxy.js";
import { ProcessSupervisor } from "./processes/ProcessSupervisor.js";
import { validOrigin } from "./security/origin.js";
import { SessionManager, type Session } from "./sessions/SessionManager.js";

const host = "127.0.0.1";
const requestedPort = Number(process.env.ZIGLIVE_PORT ?? 4317);
if (
	!Number.isInteger(requestedPort) ||
	requestedPort < 0 ||
	requestedPort > 65535
)
	throw new Error("ZIGLIVE_PORT must be an integer from 0 to 65535");

const app = Fastify({
	logger: { level: process.env.ZIGLIVE_LOG_LEVEL ?? "info" },
	bodyLimit: 64 * 1024,
});
const sessions = new SessionManager();
const supervisor = new ProcessSupervisor();
const schedulers = new Map<string, RunScheduler>();
const proxies = new Map<string, LspProxy>();
const runtimeSockets = new Map<string, WebSocket>();
const runtimeWss = new WebSocketServer({
	noServer: true,
	maxPayload: MAX_RUNTIME_MESSAGE_BYTES,
});
const lspWss = new WebSocketServer({
	noServer: true,
	maxPayload: 8 * 1024 * 1024,
});

function send(socket: WebSocket, event: RuntimeServerEvent): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

app.get("/api/health", async () => ({ ok: true, host }));
app.get("/api/doctor", async () => ({ checks: await runDoctor() }));
app.post("/api/sessions", async (request, reply) => {
	const port = app.server.address();
	const actualPort =
		typeof port === "object" && port ? port.port : requestedPort;
	if (!validOrigin(request.raw, actualPort))
		return await reply.code(403).send({ error: "Origin is not allowed" });
	return await sessions.create();
});

const webDist = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../web/dist",
);
if (process.env.NODE_ENV === "production" && existsSync(webDist)) {
	await app.register(fastifyStatic, { root: webDist, wildcard: false });
	app.get("/*", async (_request, reply) => await reply.sendFile("index.html"));
}

function authenticate(url: URL): Session | undefined {
	const id = url.searchParams.get("sessionId") ?? "";
	const token = url.searchParams.get("token") ?? "";
	return sessions.authenticate(id, token);
}

app.server.on("upgrade", (request, socket, head) => {
	const address = app.server.address();
	const actualPort =
		typeof address === "object" && address ? address.port : requestedPort;
	if (!validOrigin(request, actualPort)) {
		socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
		socket.destroy();
		return;
	}
	const url = new URL(request.url ?? "/", `http://${host}:${actualPort}`);
	const session = authenticate(url);
	if (!session) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		socket.destroy();
		return;
	}
	if (url.pathname === "/ws/runtime") {
		runtimeWss.handleUpgrade(request, socket, head, (webSocket) =>
			handleRuntime(webSocket, session),
		);
	} else if (url.pathname === "/ws/lsp") {
		lspWss.handleUpgrade(request, socket, head, (webSocket) =>
			handleLsp(webSocket, session),
		);
	} else {
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		socket.destroy();
	}
});

function handleRuntime(socket: WebSocket, session: Session): void {
	if (runtimeSockets.has(session.id)) {
		socket.close(1008, "A runtime connection already exists for this session");
		return;
	}
	runtimeSockets.set(session.id, socket);
	session.runtimeConnections++;
	const runner = new CompilerRunner(supervisor, sessions.instrumenterPath());
	const scheduler = new RunScheduler(session, runner, (event) =>
		send(socket, event),
	);
	schedulers.set(session.id, scheduler);

	socket.on("message", (data, binary) => {
		if (binary) {
			socket.close(1003, "JSON text required");
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			send(socket, {
				type: "server.error",
				recoverable: true,
				message: "Invalid JSON runtime message",
			});
			return;
		}
		const validation = runtimeClientMessageSchema.safeParse(parsed);
		if (!validation.success) {
			send(socket, {
				type: "server.error",
				recoverable: true,
				message: "Invalid runtime message",
				details: validation.error.message,
			});
			return;
		}
		const message = validation.data;
		if (message.sessionId !== session.id) {
			socket.close(1008, "Session mismatch");
			return;
		}
		void (async () => {
			try {
				if (message.type === "document.update") {
					if (Buffer.byteLength(message.source, "utf8") > MAX_SOURCE_BYTES)
						throw new Error("Source exceeds 1 MiB");
					await session.store.update(message.version, message.source);
					if (session.zigCompatible) scheduler.documentUpdated();
					else
						send(socket, {
							type: "run.state",
							documentVersion: message.version,
							state: "idle",
						});
				} else if (message.type === "run.request") {
					if (!session.zigCompatible)
						throw new Error(
							"Run is disabled: Zig 0.16.x is required. Run pnpm run doctor.",
						);
					if (message.version !== session.store.current().version)
						throw new Error("Run version is not current");
					await scheduler.run(message.version);
				} else if (message.type === "run.cancel") {
					scheduler.cancel("user");
					send(socket, {
						type: "run.state",
						documentVersion: session.store.current().version,
						state: "cancelled",
					});
				} else {
					session.settings = {
						autoRun: message.autoRun,
						autoInspect: message.autoInspect,
						debounceMs: message.debounceMs,
						timeoutMs: message.timeoutMs,
						manualProbeIds: [...message.manualProbeIds],
					};
				}
			} catch (error) {
				send(socket, {
					type: "server.error",
					recoverable: true,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	});
	socket.once("close", () => {
		runtimeSockets.delete(session.id);
		session.runtimeConnections--;
		scheduler.close();
		schedulers.delete(session.id);
		const proxy = proxies.get(session.id);
		if (proxy) void proxy.close();
		proxies.delete(session.id);
		setTimeout(() => {
			void sessions.destroy(session.id);
		}, 500).unref();
	});
	if (session.zigCompatible)
		void scheduler.run(session.store.current().version);
	else
		send(socket, {
			type: "server.error",
			recoverable: true,
			message:
				"Zig 0.16.x is unavailable; Run is disabled. Run pnpm run doctor.",
		});
}

function handleLsp(socket: WebSocket, session: Session): void {
	if (!session.zlsCompatible) {
		socket.close(1011, "ZLS 0.16.x is required");
		return;
	}
	session.lspConnections++;
	let proxy = proxies.get(session.id);
	if (!proxy) {
		proxy = new LspProxy(session);
		proxies.set(session.id, proxy);
	}
	proxy.attach(socket);
	socket.once("close", () => {
		session.lspConnections--;
	});
}

async function shutdown(signal: string): Promise<void> {
	app.log.info({ signal }, "shutting down");
	for (const scheduler of schedulers.values()) scheduler.close();
	await Promise.all(
		[...proxies.values()].map(async (proxy) => await proxy.close()),
	);
	await supervisor.close();
	await sessions.close();
	await app.close();
}

await sessions.initialize();
const address = await app.listen({ host, port: requestedPort });
app.log.info(
	{ address, warning: "El código se ejecuta localmente con tus permisos" },
	"ZigLive ready",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void shutdown(signal).finally(() => process.exit(0));
	});
