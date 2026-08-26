import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	DocumentSnapshot,
	ProbeDescriptor,
	RunResult,
	TestCase,
} from "@ziglive/protocol";
import type { Session, SessionSettings } from "../sessions/SessionManager.js";
import { PROJECT_ROOT } from "../languages/registry.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";
import { ProbeEventReader } from "./ProbeEventReader.js";
import {
	resetGenerated,
	type RunnerCallbacks,
	type RunnerOutcome,
	type ProjectDiagnostic,
} from "./CompilerRunner.js";
import { createMarkerParser } from "./RuntimeOutputParser.js";
import { discoverPyTests, matchPyTestName, PY_TEST_FILE } from "./PyTestDiscovery.js";
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

export class PyCompilerRunner {
	public constructor(
		private readonly supervisor: ProcessSupervisor,
		private readonly instrumenter: string,
	) {}

	private pyEnv(root: string, withRuntime: boolean): Record<string, string> {
		return {
			PYTHONDONTWRITEBYTECODE: "1",
			...(withRuntime ? { PYTHONPATH: join(root, "generated") } : {}),
		};
	}

	public async run(
		session: Session,
		snapshot: DocumentSnapshot,
		settings: SessionSettings,
		_runId: string,
		signal: AbortSignal,
		callbacks: RunnerCallbacks,
	): Promise<RunnerOutcome> {
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
		const testCatalog = discoverPyTests(projectFiles);
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
			if (!file.path.endsWith(".py") || PY_TEST_FILE.test(file.path)) {
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
				"python3",
				instrumentArgs,
				{
					cwd: session.root,
					signal,
					limits: {
						timeoutMs: 10_000,
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
					source: "pylive-instrument",
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
					source: "pylive-instrument",
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
					source: "pylive-instrument",
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
						source: "pylive-instrument",
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
		const execution = await this.supervisor.run(
			"python3",
			["-u", join(session.root, "generated", "main.py")],
			{
				cwd: join(session.root, "src"),
				signal,
				probeFd: true,
				env: this.pyEnv(session.root, true),
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
							probeError =
								error instanceof Error ? error.message : String(error);
						}
					},
				},
			},
		);
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
			const matches = [
				...execution.stderr.matchAll(
					/File "(?:.*[/\\])?(?:generated|src)[/\\]([\w./-]+\.py)", line (\d+)/g,
				),
			];
			const location = matches.at(-1);
			callbacks.diagnostic("runtime", [
				{
					...(location?.[1] ? { path: `src/${location[1]}` } : {}),
					message: "Program raised or exited abnormally",
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
		if (!catalog.length || signal.aborted) return;
		callbacks.state("testing");
		const started = new Map<number, string>();
		const counts = { passed: 0, failed: 0, skipped: 0 };
		let stderrBuffer = "";
		let summary: (typeof counts & { leaked?: number }) | undefined;
		let readError: string | undefined;
		const emitResult = (raw: RawTestResult): void => {
			started.delete(raw.index);
			const status = raw.status === "leaked" ? "failed" : raw.status;
			counts[status]++;
			const matched = matchPyTestName(catalog, raw.name);
			const failing = status === "failed";
			const message = failing
				? stderrBuffer.trim().slice(0, 1200) || raw.error
				: undefined;
			callbacks.testResult({
				...(matched ? { testId: matched.testId } : {}),
				name: matched?.name ?? raw.name,
				status,
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
				};
		});
		const testFiles = catalog
			.map((test) => join(session.root, test.path))
			.filter((path, index, all) => all.indexOf(path) === index);
		const runner = join(
			PROJECT_ROOT,
			"python",
			"test-runner",
			"ziglive_test_runner.py",
		);
		const execution = await this.supervisor.run(
			"python3",
			["-u", runner, ...testFiles],
			{
				cwd: join(session.root, "src"),
				signal,
				probeFd: true,
				env: this.pyEnv(session.root, false),
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
			},
		);
		try {
			reader.end();
		} catch (error) {
			readError ??= error instanceof Error ? error.message : String(error);
		}
		if (execution.cancelled || signal.aborted) return;
		for (const name of started.values()) {
			counts.failed++;
			const matched = matchPyTestName(catalog, name);
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
		if (!summary && execution.exitCode !== 0 && stderrBuffer.trim())
			callbacks.output("stderr", stderrBuffer, "error");
		if (readError)
			callbacks.output("stderr", `test channel error: ${readError}\n`, "error");
		callbacks.testSummary({
			...(summary ?? counts),
			leaked: 0,
			durationMs: execution.durationMs,
		});
	}
}
