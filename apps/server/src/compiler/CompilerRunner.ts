import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type {
	AppDiagnostic,
	DocumentSnapshot,
	ProbeDescriptor,
	ProbeValueEvent,
	RunResult,
} from "@ziglive/protocol";
import type { Session, SessionSettings } from "../sessions/SessionManager.js";
import { parseCompilerDiagnostics } from "../diagnostics/DiagnosticMapper.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";
import { ProbeEventReader } from "./ProbeEventReader.js";

type ProjectDiagnostic = AppDiagnostic & { path?: string };
type ProjectProbe = ProbeDescriptor & { path?: string };

interface ProjectFile {
	path: string;
	uri: string;
	source: string;
}

interface LogSourceLocation {
	path?: string;
	line: number;
	column: number;
	executionIndex: number;
	loop?: {
		line: number;
		column: number;
		variable: string;
		value: string;
	};
}

interface InstrumentationOutput {
	protocolVersion: 1;
	documentVersion: number;
	generatedPath?: string;
	sourceMapPath?: string;
	probes: ProbeDescriptor[];
	parseDiagnostics: { message: string; severity: string }[];
}

export interface RunnerCallbacks {
	state: (state: "instrumenting" | "compiling" | "running") => void;
	catalog: (probes: ProbeDescriptor[]) => void;
	output: (
		stream: "stdout" | "stderr",
		chunk: string,
		category: "program" | "error",
		sourceLocation?: LogSourceLocation,
	) => void;
	diagnostic: (owner: string, diagnostics: ProjectDiagnostic[]) => void;
	probe: (
		event: Omit<
			ProbeValueEvent,
			"sessionId" | "runId" | "documentVersion" | "timestamp" | "count" | "type"
		> & { count?: number },
	) => void;
}

export interface RunnerOutcome {
	result: RunResult;
	terminalState:
		| "succeeded"
		| "compile_error"
		| "runtime_error"
		| "timed_out"
		| "cancelled";
}

export class CompilerRunner {
	public constructor(
		private readonly supervisor: ProcessSupervisor,
		private readonly instrumenter: string,
	) {}

	public async run(
		session: Session,
		snapshot: DocumentSnapshot,
		settings: SessionSettings,
		_runId: string,
		signal: AbortSignal,
		callbacks: RunnerCallbacks,
	): Promise<RunnerOutcome> {
		const generatedPath = join(session.root, "generated", "main.zig");
		const metrics: RunResult = {
			instrumentationMs: 0,
			compilationMs: 0,
			executionMs: 0,
			exitCode: null,
			signal: null,
			timedOut: false,
			cancelled: false,
		};

		callbacks.state("instrumenting");
		const projectFiles = (
			snapshot as DocumentSnapshot & { files: ProjectFile[] }
		).files;
		const runtimePath = join(session.root, "generated", "runzig_runtime.zig");
		const runtimeSource = await readFile(runtimePath);
		await rm(join(session.root, "generated"), { recursive: true, force: true });
		await mkdir(join(session.root, "generated"), { recursive: true, mode: 0o700 });
		await writeFile(runtimePath, runtimeSource, { mode: 0o600 });
		const probes: ProjectProbe[] = [];
		const instrumentDiagnostics: ProjectDiagnostic[] = [];
		const fileIds = new Map<number, string>();
		let fileId = 0;
		for (const file of projectFiles) {
			const sourcePath = join(session.root, "src", file.path);
			const outputPath = join(session.root, "generated", file.path);
			await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
			if (extname(file.path).toLowerCase() !== ".zig") {
				await copyFile(sourcePath, outputPath);
				continue;
			}
			fileId++;
			fileIds.set(fileId, `src/${file.path}`);
			const sourceMapPath = join(
				session.root,
				"generated",
				`.ziglive-${fileId}.json`,
			);
			const instrumentArgs = [
				"--input",
				sourcePath,
				"--output",
				outputPath,
				"--source-map",
				sourceMapPath,
				"--uri",
				file.uri,
				"--version",
				String(snapshot.version),
				"--file-id",
				String(fileId),
			];
			if (!settings.autoInspect) instrumentArgs.push("--no-auto-inspect");
			for (const id of settings.manualProbeIds)
				instrumentArgs.push("--manual", id);
			const instrument = await this.supervisor.run(
				this.instrumenter,
				instrumentArgs,
				{
					cwd: session.root,
					signal,
					limits: {
						timeoutMs: 5000,
						stdoutBytes: 1024 * 1024,
						stderrBytes: 512 * 1024,
					},
				},
			);
			metrics.instrumentationMs += instrument.durationMs;
			if (instrument.cancelled || signal.aborted)
				return {
					terminalState: "cancelled",
					result: { ...metrics, cancelled: true, reason: "superseded" },
				};
			if (instrument.exitCode !== 0) {
				callbacks.output("stderr", instrument.stderr, "error");
				instrumentDiagnostics.push({
					path: `src/${file.path}`,
					message: "Instrumentation failed",
					severity: "error",
					line: 1,
					column: 1,
					source: "runzig-instrument",
				});
				continue;
			}
			let metadata: InstrumentationOutput;
			try {
				metadata = JSON.parse(instrument.stdout) as InstrumentationOutput;
			} catch (error) {
				instrumentDiagnostics.push({
					path: `src/${file.path}`,
					message: `Invalid instrumenter response: ${error instanceof Error ? error.message : String(error)}`,
					severity: "error",
					line: 1,
					column: 1,
					source: "runzig-instrument",
				});
				continue;
			}
			if (
				metadata.protocolVersion !== 1 ||
				metadata.documentVersion !== snapshot.version ||
				!Array.isArray(metadata.probes)
			) {
				instrumentDiagnostics.push({
					path: `src/${file.path}`,
					message: "Instrumenter protocol/version mismatch",
					severity: "error",
					line: 1,
					column: 1,
					source: "runzig-instrument",
				});
				continue;
			}
			probes.push(
				...metadata.probes.map((probe) => ({
					...probe,
					path: `src/${file.path}`,
				})),
			);
			if (!metadata.generatedPath)
				instrumentDiagnostics.push(
					...metadata.parseDiagnostics.map((item) => ({
						path: `src/${file.path}`,
						message: item.message,
						severity: "error" as const,
						line: 1,
						column: 1,
						source: "runzig-instrument",
					})),
				);
		}
		session.probes = probes;
		callbacks.catalog(probes);
		callbacks.diagnostic("ziglive-instrumenter", instrumentDiagnostics);
		if (instrumentDiagnostics.length)
			return {
				terminalState: "compile_error",
				result: { ...metrics, reason: "instrumentation error" },
			};

		callbacks.state("compiling");
		const compile = await this.supervisor.run(
			"zig",
			["build", "instrumented", "--color", "off"],
			{
				cwd: session.root,
				signal,
				limits: {
					timeoutMs: 30_000,
					stdoutBytes: 512 * 1024,
					stderrBytes: 512 * 1024,
				},
				callbacks: {
					stdout: (chunk) => callbacks.output("stdout", chunk, "program"),
					stderr: (chunk) => callbacks.output("stderr", chunk, "error"),
				},
			},
		);
		metrics.compilationMs = compile.durationMs;
		if (compile.cancelled || signal.aborted)
			return {
				terminalState: "cancelled",
				result: { ...metrics, cancelled: true, reason: "superseded" },
			};
		if (compile.exitCode !== 0 || compile.limit) {
			callbacks.diagnostic(
				"zig-compiler",
				parseCompilerDiagnostics(compile.stderr, generatedPath),
			);
			return {
				terminalState: "compile_error",
				result: {
					...metrics,
					exitCode: compile.exitCode,
					signal: compile.signal,
					reason: compile.limit
						? `${compile.limit} output limit exceeded`
						: "compiler error",
				},
			};
		}
		callbacks.diagnostic("zig-compiler", []);

		callbacks.state("running");
		const counts = new Map<string, number>();
		const logCounts = new Map<string, number>();
		let probeError: string | undefined;
		let runtimeStderrIsError = false;
		let runtimeStderrBuffer = "";
		const logMarker =
			/\x1eZIGLIVE_LOG:(\d+):(\d+):(\d+)(?::(\d+):(\d+):([A-Za-z_][A-Za-z0-9_]*):([\s\S]*?))?\x1f/;
		const emitRuntimeStderrText = (
			text: string,
			sourceLocation?: LogSourceLocation,
		): void => {
			for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
				if (/(?:^|\s)(?:thread \d+ )?panic:/i.test(line))
					runtimeStderrIsError = true;
				const lineIsError =
					runtimeStderrIsError || /(?:^|\s)error:/i.test(line);
				callbacks.output(
					"stderr",
					line,
					lineIsError ? "error" : "program",
					runtimeStderrIsError ? undefined : sourceLocation,
				);
			}
		};
		const emitRuntimeStderr = (chunk: string): void => {
			runtimeStderrBuffer += chunk;
			let marker = logMarker.exec(runtimeStderrBuffer);
			while (marker?.[1] && marker[2] && marker[3]) {
				const path = fileIds.get(Number(marker[1]));
				const line = Number(marker[2]);
				const column = Number(marker[3]);
				const countKey = `${path ?? "unknown"}:${line}:${column}`;
				const executionIndex = (logCounts.get(countKey) ?? 0) + 1;
				logCounts.set(countKey, executionIndex);
				const sourceLocation: LogSourceLocation = {
					...(path ? { path } : {}),
					line,
					column,
					executionIndex,
					...(marker[4] && marker[5] && marker[6] && marker[7] !== undefined
						? {
								loop: {
									line: Number(marker[4]),
									column: Number(marker[5]),
									variable: marker[6],
									value: marker[7],
								},
							}
						: {}),
				};
				emitRuntimeStderrText(
					runtimeStderrBuffer.slice(0, marker.index),
					sourceLocation,
				);
				runtimeStderrBuffer = runtimeStderrBuffer.slice(
					marker.index + marker[0].length,
				);
				marker = logMarker.exec(runtimeStderrBuffer);
			}
		};
		const flushRuntimeStderr = (): void => {
			emitRuntimeStderrText(runtimeStderrBuffer);
			runtimeStderrBuffer = "";
		};
		const probePaths = new Map(
			probes.map((probe) => [probe.probeId, probe.path] as const),
		);
		const reader = new ProbeEventReader((event) => {
			const count = (counts.get(event.probeId) ?? 0) + 1;
			counts.set(event.probeId, count);
			const path = probePaths.get(event.probeId);
			callbacks.probe({ ...event, ...(path ? { path } : {}), count });
		});
		const executable = join(session.root, "zig-out", "bin", "ziglive-session");
		const execution = await this.supervisor.run(executable, [], {
			cwd: join(session.root, "src"),
			signal,
			probeFd: true,
			limits: {
				timeoutMs: settings.timeoutMs,
				stdoutBytes: 512 * 1024,
				stderrBytes: 512 * 1024,
				probeBytes: 1024 * 1024,
			},
			callbacks: {
				stdout: (chunk) => callbacks.output("stdout", chunk, "program"),
				stderr: emitRuntimeStderr,
				probe: (chunk) => {
					try {
						reader.push(chunk);
					} catch (error) {
						probeError = error instanceof Error ? error.message : String(error);
					}
				},
			},
		});
		flushRuntimeStderr();
		metrics.executionMs = execution.durationMs;
		metrics.exitCode = execution.exitCode;
		metrics.signal = execution.signal;
		metrics.timedOut = execution.timedOut;
		metrics.cancelled = execution.cancelled;
		try {
			reader.end();
		} catch (error) {
			probeError ??= error instanceof Error ? error.message : String(error);
		}
		if (execution.cancelled || signal.aborted)
			return {
				terminalState: "cancelled",
				result: { ...metrics, reason: "cancelled" },
			};
		if (execution.timedOut)
			return {
				terminalState: "timed_out",
				result: { ...metrics, reason: "execution timeout" },
			};
		if (execution.limit || probeError)
			return {
				terminalState: "runtime_error",
				result: {
					...metrics,
					reason:
						probeError ?? `${execution.limit ?? "runtime"} limit exceeded`,
				},
			};
		if (execution.exitCode !== 0 || execution.signal) {
			const location = new RegExp(
				`${generatedPath.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:(\\d+):(\\d+)`,
			).exec(execution.stderr);
			callbacks.diagnostic("zig-runtime", [
				{
					message: "Program panicked or exited abnormally",
					severity: "error",
					line: Number(location?.[1] ?? 1),
					column: Number(location?.[2] ?? 1),
					source: "runtime",
				},
			]);
			return {
				terminalState: "runtime_error",
				result: { ...metrics, reason: "abnormal exit" },
			};
		}
		callbacks.diagnostic("zig-runtime", []);
		return { terminalState: "succeeded", result: metrics };
	}
}
