import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import type { Session } from "../sessions/SessionManager.js";
import { filterObservedUnused } from "../diagnostics/DiagnosticMapper.js";
import { LspFramer } from "./LspFramer.js";

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
	result?: unknown;
}

export class LspProxy {
	private process: ChildProcessWithoutNullStreams | undefined;
	private socket: WebSocket | undefined;
	private framer = new LspFramer();
	private restarts = 0;
	private closing = false;

	public constructor(
		private readonly session: Session,
		private readonly language: "zig" | "rust" = "zig",
		private readonly commandOverride?: string,
	) {}

	public attach(socket: WebSocket): void {
		this.socket = socket;
		if (!this.process) this.start();
		socket.on("message", (data, binary) => {
			if (binary) {
				socket.close(1003, "JSON text messages required");
				return;
			}
			let message: unknown;
			try {
				message = JSON.parse(data.toString());
			} catch {
				socket.close(1007, "Invalid JSON");
				return;
			}
			if (!message || typeof message !== "object") {
				socket.close(1007, "Invalid JSON-RPC message");
				return;
			}
			this.process?.stdin.write(LspFramer.frame(message));
		});
	}

	private start(): void {
		this.framer = new LspFramer();
		const rust = this.language === "rust";
		const command = this.commandOverride ?? (rust ? "rust-analyzer" : "zls");
		const args = rust
			? []
			: ["--config-path", `${this.session.root}/zls.json`];
		const child = spawn(command, args, {
			cwd: this.session.root,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				for (const message of this.framer.push(chunk))
					this.forward(message as JsonRpcMessage);
			} catch (error) {
				this.socket?.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "window/showMessage",
						params: {
							type: 1,
							message: `Invalid ZLS framing: ${error instanceof Error ? error.message : String(error)}`,
						},
					}),
				);
				void this.stopProcess();
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			console.error(
				JSON.stringify({
					component: this.language === "rust" ? "rust-analyzer" : "zls",
					sessionId: this.session.id,
					message: chunk.trim(),
				}),
			);
		});
		child.once("error", (error) => {
			this.socket?.send(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "window/showMessage",
					params: { type: 1, message: `Language server unavailable: ${error.message}` },
				}),
			);
		});
		child.once("close", () => {
			this.process = undefined;
			if (!this.closing && this.restarts++ === 0) {
				this.start();
				this.socket?.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "ziglive/lspRestarted",
						params: {},
					}),
				);
			} else if (!this.closing) {
				this.socket?.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "window/showMessage",
						params: {
							type: 1,
							message: "Language server stopped twice; editor continues in degraded mode.",
						},
					}),
				);
			}
		});
	}

	private forward(message: JsonRpcMessage): void {
		if (
			message.method === "textDocument/publishDiagnostics" &&
			message.params &&
			typeof message.params === "object"
		) {
			const params = message.params as {
				diagnostics?: unknown;
				uri?: string;
			};
			if (Array.isArray(params.diagnostics) && this.language === "zig") {
				const file = this.session.store
					.current()
					.files.find((candidate) => candidate.uri === params.uri);
				const projectPath = file ? `src/${file.path}` : undefined;
				params.diagnostics = filterObservedUnused(
					params.diagnostics,
					this.session.probes.filter(
						(probe) => !("path" in probe) || probe.path === projectPath,
					),
				);
			}
		}
		const socket = this.socket;
		if (socket && socket.readyState === socket.OPEN)
			socket.send(JSON.stringify(message));
	}

	private async stopProcess(): Promise<void> {
		const child = this.process;
		if (!child) return;
		child.stdin.write(
			LspFramer.frame({
				jsonrpc: "2.0",
				id: "ziglive-shutdown",
				method: "shutdown",
				params: null,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		child.stdin.write(
			LspFramer.frame({ jsonrpc: "2.0", method: "exit", params: null }),
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), 500);
		timer.unref();
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		clearTimeout(timer);
	}

	public async close(): Promise<void> {
		this.closing = true;
		await this.stopProcess();
		this.socket = undefined;
	}
}
