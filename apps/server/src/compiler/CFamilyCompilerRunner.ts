import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	DocumentSnapshot,
	ProbeDescriptor,
	RunResult,
	TestCase,
} from "@ziglive/protocol";
import type { Session, SessionSettings } from "../sessions/SessionManager.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";
import { ProbeEventReader } from "./ProbeEventReader.js";
import {
	resetGenerated,
	type RunnerCallbacks,
	type RunnerOutcome,
	type ProjectDiagnostic,
} from "./CompilerRunner.js";
import { createMarkerParser } from "./RuntimeOutputParser.js";
import {
	buildCFamilyTestMain,
	discoverCFamilyTests,
	parseClangDiagnostics,
} from "./CFamilyDiscovery.js";
import { TestEventReader, type RawTestResult } from "./TestEventReader.js";

type ProjectProbe = ProbeDescriptor & { path?: string };

interface ProjectFile {
	path: string;
	uri: string;
	source: string;
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

export interface CFamilyConfig {
	language: "c" | "cpp";
	compiler: string;
	std: string;
	codeFile: RegExp;
	testFile: RegExp;
	runtimeHeader: string;
	testMainName: string;
}

const COMPILE_TIMEOUT_MS = 60_000;

export class CFamilyCompilerRunner {
	public constructor(
		private readonly supervisor: ProcessSupervisor,
		private readonly instrumenter: string,
		private readonly config: CFamilyConfig,
	) {}

	public async run(
		session: Session,
		snapshot: DocumentSnapshot,
		settings: SessionSettings,
		_runId: string,
		signal: AbortSignal,
		callbacks: RunnerCallbacks,
	): Promise<RunnerOutcome> {
		const { config } = this;
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
		const testCatalog = discoverCFamilyTests(projectFiles, config.testFile);
		callbacks.testCatalog(testCatalog);
		await resetGenerated(session.root);
		const probes: ProjectProbe[] = [];
		const instrumentDiagnostics: ProjectDiagnostic[] = [];
		const fileIds = new Map<number, string>();
		let fileId = 0;
		for (const file of projectFiles) {
			const sourcePath = join(session.root, "src", file.path);
			const outputPath = join(session.root, "generated", file.path);
			await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
			if (
				!config.codeFile.test(file.path) ||
				config.testFile.test(file.path)
			) {
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
				this.instrumenter,
				"--lang",
				config.language,
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
			const instrument = await this.supervisor.run("node", instrumentArgs, {
				cwd: session.root,
				signal,
				limits: {
					timeoutMs: 15_000,
					stdoutBytes: 1024 * 1024,
					stderrBytes: 512 * 1024,
				},
			});
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
					source: "clive-instrument",
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
					source: "clive-instrument",
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
					source: "clive-instrument",
				});
				continue;
			}
			probes.push(
				...metadata.probes.map((probe) => ({
					...probe,
					path: `src/${file.path}`,
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
		const codeFiles = projectFiles.filter(
			(file) =>
				config.codeFile.test(file.path) && !config.testFile.test(file.path),
		);
		const executable = join(session.root, "target", `${config.language}-bin`);
		await mkdir(join(session.root, "target"), {
			recursive: true,
			mode: 0o700,
		});
		const compile = await this.supervisor.run(
			config.compiler,
			[
				`-std=${config.std}`,
				"-g",
				"-O0",
				"-include",
				join(session.root, "generated", config.runtimeHeader),
				...codeFiles.map((file) =>
					join(session.root, "generated", file.path),
				),
				"-o",
				executable,
				"-lm",
			],
			{
				cwd: session.root,
				signal,
				limits: {
					timeoutMs: COMPILE_TIMEOUT_MS,
					stdoutBytes: 512 * 1024,
					stderrBytes: 1024 * 1024,
				},
			},
		);
		metrics.compilationMs = compile.durationMs;
		if (compile.cancelled || signal.aborted)
			return {
				terminalState: "cancelled",
				result: { ...metrics, cancelled: true, reason: "superseded" },
			};
		const compileDiagnostics = parseClangDiagnostics(compile.stderr);
		callbacks.diagnostic("compiler", compileDiagnostics);
		if (compile.exitCode !== 0 || compile.limit) {
			if (!compileDiagnostics.length)
				callbacks.output("stderr", compile.stderr, "error");
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

		callbacks.state("running");
		const counts = new Map<string, number>();
		let probeError: string | undefined;
		const stdoutParser = createMarkerParser({
			stream: "stdout",
			detectErrors: false,
			fileIds,
			emit: callbacks.output,
		});
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
				stdout: (chunk) => stdoutParser.push(chunk),
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
		stdoutParser.flush();
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
			const location =
				/(?:generated|src)[/\\]([\w./-]+\.(?:c|cpp|cc|h|hpp)):(\d+)/.exec(
					execution.stderr,
				);
			callbacks.diagnostic("runtime", [
				{
					...(location?.[1] ? { path: `src/${location[1]}` } : {}),
					message: "Program crashed or exited abnormally",
					severity: "error",
					line: Number(location?.[2] ?? 1),
					column: 1,
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
		const { config } = this;
		if (!catalog.length || signal.aborted) return;
		callbacks.state("testing");
		const testMainPath = join(session.root, "generated", config.testMainName);
		await writeFile(
			testMainPath,
			buildCFamilyTestMain(catalog, config.language),
			{ encoding: "utf8", mode: 0o600 },
		);
		const snapshotFiles = session.store.current().files;
		const userSources = snapshotFiles.filter(
			(file) =>
				config.codeFile.test(file.path) && !config.testFile.test(file.path),
		);
		const testSources = snapshotFiles.filter((file) =>
			config.testFile.test(file.path),
		);
		const objectDir = join(session.root, "target", `${config.language}-obj`);
		await mkdir(objectDir, { recursive: true, mode: 0o700 });
		const objects: string[] = [];
		for (const [index, file] of userSources.entries()) {
			const object = join(objectDir, `${index}.o`);
			const compile = await this.supervisor.run(
				config.compiler,
				[
					`-std=${config.std}`,
					"-g",
					"-O0",
					"-Dmain=__ziglive_user_main",
					"-c",
					join(session.root, "src", file.path),
					"-o",
					object,
				],
				{
					cwd: session.root,
					signal,
					limits: {
						timeoutMs: COMPILE_TIMEOUT_MS,
						stdoutBytes: 256 * 1024,
						stderrBytes: 1024 * 1024,
					},
				},
			);
			if (compile.cancelled || signal.aborted) return;
			if (compile.exitCode !== 0) {
				const diagnostics = parseClangDiagnostics(compile.stderr);
				if (diagnostics.length) callbacks.diagnostic("compiler", diagnostics);
				else callbacks.output("stderr", compile.stderr, "error");
				callbacks.testSummary({
					passed: 0,
					failed: 0,
					skipped: 0,
					leaked: 0,
					durationMs: compile.durationMs,
				});
				return;
			}
			objects.push(object);
		}
		const testExecutable = join(
			session.root,
			"target",
			`${config.language}-test-bin`,
		);
		const link = await this.supervisor.run(
			config.compiler,
			[
				`-std=${config.std}`,
				"-g",
				"-O0",
				...objects,
				...testSources.map((file) => join(session.root, "src", file.path)),
				testMainPath,
				"-o",
				testExecutable,
				"-lm",
			],
			{
				cwd: session.root,
				signal,
				limits: {
					timeoutMs: COMPILE_TIMEOUT_MS,
					stdoutBytes: 256 * 1024,
					stderrBytes: 1024 * 1024,
				},
			},
		);
		if (link.cancelled || signal.aborted) return;
		if (link.exitCode !== 0) {
			const diagnostics = parseClangDiagnostics(link.stderr);
			if (diagnostics.length) callbacks.diagnostic("compiler", diagnostics);
			else callbacks.output("stderr", link.stderr, "error");
			callbacks.testSummary({
				passed: 0,
				failed: 0,
				skipped: 0,
				leaked: 0,
				durationMs: link.durationMs,
			});
			return;
		}

		const started = new Map<number, string>();
		const counts = { passed: 0, failed: 0, skipped: 0 };
		let stderrBuffer = "";
		let summary: typeof counts | undefined;
		let readError: string | undefined;
		const emitResult = (raw: RawTestResult): void => {
			started.delete(raw.index);
			const status = raw.status === "leaked" ? "failed" : raw.status;
			counts[status]++;
			const matched = catalog.find(
				(candidate) => candidate.name === raw.name,
			);
			callbacks.testResult({
				...(matched ? { testId: matched.testId } : {}),
				name: matched?.name ?? raw.name,
				status,
				durationMs: raw.durationNs / 1_000_000,
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
				};
		});
		const execution = await this.supervisor.run(testExecutable, [], {
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
			const matched = catalog.find((candidate) => candidate.name === name);
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
			leaked: 0,
			durationMs: execution.durationMs,
		});
	}
}
