import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";

export interface ProcessLimits {
	timeoutMs: number;
	stdoutBytes: number;
	stderrBytes: number;
	probeBytes?: number;
}

export interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	cancelled: boolean;
	limit?: "stdout" | "stderr" | "probes";
	durationMs: number;
}

export interface ProcessCallbacks {
	stdout?: (chunk: string) => void;
	stderr?: (chunk: string) => void;
	probe?: (chunk: Buffer) => void;
}

export class ProcessSupervisor {
	private readonly children = new Set<ChildProcess>();

	public async run(
		command: string,
		args: readonly string[],
		options: {
			cwd: string;
			limits: ProcessLimits;
			signal?: AbortSignal;
			probeFd?: boolean;
			env?: Record<string, string>;
			callbacks?: ProcessCallbacks;
		},
	): Promise<ProcessResult> {
		const started = performance.now();
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			shell: false,
			windowsHide: true,
			...(options.env ? { env: { ...process.env, ...options.env } } : {}),
			stdio: options.probeFd
				? ["ignore", "pipe", "pipe", "pipe"]
				: ["ignore", "pipe", "pipe"],
		});
		this.children.add(child);
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let probeBytes = 0;
		let timedOut = false;
		let cancelled = false;
		let limit: ProcessResult["limit"];
		let terminating = false;

		const terminate = async (): Promise<void> => {
			if (terminating || child.exitCode !== null || child.signalCode !== null)
				return;
			terminating = true;
			this.signalGroup(child, "SIGTERM");
			const force = setTimeout(() => this.signalGroup(child, "SIGKILL"), 250);
			force.unref();
			await once(child, "close").catch(() => undefined);
			clearTimeout(force);
		};
		const abort = (): void => {
			cancelled = true;
			void terminate();
		};
		options.signal?.addEventListener("abort", abort, { once: true });

		const timer = setTimeout(() => {
			timedOut = true;
			void terminate();
		}, options.limits.timeoutMs);
		timer.unref();

		const consume = (
			stream: Readable | null,
			kind: "stdout" | "stderr",
		): void => {
			stream?.on("data", (data: Buffer) => {
				if (kind === "stdout") {
					stdoutBytes += data.length;
					stdout += data.toString("utf8");
					options.callbacks?.stdout?.(data.toString("utf8"));
					if (stdoutBytes > options.limits.stdoutBytes) {
						limit = "stdout";
						void terminate();
					}
				} else {
					stderrBytes += data.length;
					stderr += data.toString("utf8");
					options.callbacks?.stderr?.(data.toString("utf8"));
					if (stderrBytes > options.limits.stderrBytes) {
						limit = "stderr";
						void terminate();
					}
				}
			});
		};
		consume(child.stdout, "stdout");
		consume(child.stderr, "stderr");
		if (options.probeFd) {
			const probe = child.stdio[3];
			if (probe instanceof Readable)
				probe.on("data", (data: Buffer) => {
					probeBytes += data.length;
					options.callbacks?.probe?.(data);
					if (probeBytes > (options.limits.probeBytes ?? 1024 * 1024)) {
						limit = "probes";
						void terminate();
					}
				});
		}

		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		try {
			[exitCode, exitSignal] = await new Promise<
				[number | null, NodeJS.Signals | null]
			>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve([code, signal]));
			});
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			this.children.delete(child);
		}
		return {
			stdout,
			stderr,
			exitCode,
			signal: exitSignal,
			timedOut,
			cancelled,
			...(limit ? { limit } : {}),
			durationMs: performance.now() - started,
		};
	}

	private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
		if (!child.pid) return;
		try {
			process.kill(
				process.platform === "win32" ? child.pid : -child.pid,
				signal,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}

	public async close(): Promise<void> {
		for (const child of this.children) this.signalGroup(child, "SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 50));
		for (const child of this.children) this.signalGroup(child, "SIGKILL");
		this.children.clear();
	}
}
