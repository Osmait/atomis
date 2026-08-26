import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type {
	AppDiagnostic,
	DocumentSnapshot,
	ProbeDescriptor,
	ProbeValueEvent,
	RunResult,
	TestCase,
	TestStatus,
} from "@ziglive/protocol";
import type { Session, SessionSettings } from "../sessions/SessionManager.js";
import { parseCompilerDiagnostics } from "../diagnostics/DiagnosticMapper.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";
import { ProbeEventReader } from "./ProbeEventReader.js";
import { createMarkerParser } from "./RuntimeOutputParser.js";
import { discoverTests, matchRunnerName } from "./TestDiscovery.js";
import { TestEventReader, type RawTestResult } from "./TestEventReader.js";

export type ProjectDiagnostic = AppDiagnostic & { path?: string };
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
	parseDiagnostics: {
		message: string;
		severity: string;
		line?: number;
		column?: number;
	}[];
}

export interface RunnerCallbacks {
	state: (state: "instrumenting" | "compiling" | "running" | "testing") => void;
	catalog: (probes: ProbeDescriptor[]) => void;
	testCatalog: (tests: TestCase[]) => void;
	testResult: (result: {
		testId?: string;
		name: string;
		status: TestStatus;
		durationMs: number;
		message?: string;
	}) => void;
	testSummary: (summary: {
		passed: number;
		failed: number;
		skipped: number;
		leaked: number;
		durationMs: number;
	}) => void;
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

const RUNTIME_FILES = [
	"runzig_runtime.zig",
	"ziglive_runtime.rs",
	"ziglive_runtime.go",
	"__ziglive_runtime.mjs",
] as const;

/**
 * Clears the generated mirror while preserving every language runtime that is
 * present, so alternating Zig and Rust runs in the same bilingual workspace
 * never destroy each other's support files.
 */
export async function resetGenerated(root: string): Promise<void> {
	const generated = join(root, "generated");
	const preserved: [string, Buffer][] = [];
	for (const name of RUNTIME_FILES) {
		try {
			preserved.push([name, await readFile(join(generated, name))]);
		} catch {
			// runtime for the other language is absent; nothing to keep
		}
	}
	await rm(generated, { recursive: true, force: true });
	await mkdir(generated, { recursive: true, mode: 0o700 });
	for (const [name, content] of preserved)
		await writeFile(join(generated, name), content, { mode: 0o600 });
}

export interface LanguageRunner {
	run(
		session: Session,
		snapshot: DocumentSnapshot,
		settings: SessionSettings,
		runId: string,
		signal: AbortSignal,
		callbacks: RunnerCallbacks,
	): Promise<RunnerOutcome>;
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
		const testCatalog = discoverTests(projectFiles);
		callbacks.testCatalog(testCatalog);
		const testImports = projectFiles
			.filter((file) => extname(file.path).toLowerCase() === ".zig")
			.map(
				(file) =>
					`    _ = @import("src/${file.path.replaceAll('"', '\\"')}");\n`,
			)
			.join("");
		await writeFile(
			join(session.root, "test_root.zig"),
			`comptime {\n${testImports}}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await resetGenerated(session.root);
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
						line: item.line ?? 1,
						column: item.column ?? 1,
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
			[
				"build",
				"instrumented",
				...(testCatalog.length ? ["tests"] : []),
				"--color",
				"off",
			],
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
				"compiler",
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
		callbacks.diagnostic("compiler", []);

		callbacks.state("running");
		const counts = new Map<string, number>();
		let probeError: string | undefined;
		const stderrParser = createMarkerParser({
			stream: "stderr",
			detectErrors: true,
			fileIds,
			emit: callbacks.output,
		});
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
				stderr: (chunk) => stderrParser.push(chunk),
				probe: (chunk) => {
					try {
						reader.push(chunk);
					} catch (error) {
						probeError = error instanceof Error ? error.message : String(error);
					}
				},
			},
		});
		stderrParser.flush();
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
			callbacks.diagnostic("runtime", [
				{
					message: "Program panicked or exited abnormally",
					severity: "error",
					line: Number(location?.[1] ?? 1),
					column: Number(location?.[2] ?? 1),
					source: "runtime",
				},
			]);
			await this.runTests(session, settings, testCatalog, signal, callbacks);
			return {
				terminalState: "runtime_error",
				result: { ...metrics, reason: "abnormal exit" },
			};
		}
		callbacks.diagnostic("runtime", []);
		await this.runTests(session, settings, testCatalog, signal, callbacks);
		return { terminalState: "succeeded", result: metrics };
	}

	private async runTests(
		session: Session,
		settings: SessionSettings,
		catalog: TestCase[],
		signal: AbortSignal,
		callbacks: RunnerCallbacks,
	): Promise<void> {
		if (!catalog.length || signal.aborted) return;
		callbacks.state("testing");
		const started = new Map<number, string>();
		const counts = { passed: 0, failed: 0, skipped: 0, leaked: 0 };
		let stderrBuffer = "";
		let summary: typeof counts | undefined;
		let readError: string | undefined;
		const emitResult = (raw: RawTestResult): void => {
			started.delete(raw.index);
			counts[raw.status]++;
			const matched = matchRunnerName(catalog, raw.name);
			const failing = raw.status === "failed" || raw.status === "leaked";
			const message = failing
				? stderrBuffer.trim().slice(0, 1200) || raw.error
				: undefined;
			callbacks.testResult({
				...(matched ? { testId: matched.testId } : {}),
				name: matched?.name ?? raw.name,
				status: raw.status,
				durationMs: raw.durationNs / 1_000_000,
				...(message ? { message } : {}),
			});
			stderrBuffer = "";
		};
		const reader = new TestEventReader((event) => {
			if (event.kind === "test_start") {
				started.set(event.index, event.name);
				stderrBuffer = "";
			} else if (event.kind === "test_result") emitResult(event);
			else
				summary = {
					passed: event.passed,
					failed: event.failed,
					skipped: event.skipped,
					leaked: event.leaked,
				};
		});
		const executable = join(session.root, "zig-out", "bin", "ziglive-tests");
		const execution = await this.supervisor.run(executable, [], {
			cwd: join(session.root, "src"),
			signal,
			probeFd: true,
			limits: {
				timeoutMs: Math.max(settings.timeoutMs, 3000),
				stdoutBytes: 512 * 1024,
				stderrBytes: 512 * 1024,
				probeBytes: 1024 * 1024,
			},
			callbacks: {
				stderr: (chunk) => {
					stderrBuffer += chunk;
				},
				probe: (chunk) => {
					try {
						reader.push(chunk);
					} catch (error) {
						readError ??=
							error instanceof Error ? error.message : String(error);
					}
				},
			},
		});
		try {
			reader.end();
		} catch (error) {
			readError ??= error instanceof Error ? error.message : String(error);
		}
		if (execution.cancelled || signal.aborted) return;
		for (const name of started.values()) {
			counts.failed++;
			const matched = matchRunnerName(catalog, name);
			const tail = stderrBuffer.trim().slice(0, 1200);
			callbacks.testResult({
				...(matched ? { testId: matched.testId } : {}),
				name: matched?.name ?? name,
				status: execution.timedOut ? "timed_out" : "failed",
				durationMs: 0,
				...(tail ? { message: tail } : {}),
			});
			stderrBuffer = "";
		}
		if (readError)
			callbacks.output("stderr", `test channel error: ${readError}\n`, "error");
		callbacks.testSummary({
			...(summary ?? counts),
			durationMs: execution.durationMs,
		});
	}
}
