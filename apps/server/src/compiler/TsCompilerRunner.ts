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
import {
	discoverTsTests,
	parseTapOutput,
	parseTscDiagnostics,
	TS_TEST_FILE,
} from "./TsTestDiscovery.js";

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

const TSC_TIMEOUT_MS = 60_000;
const CODE_EXTENSION = /\.(ts|js|mjs)$/;

export class TsCompilerRunner {
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
		const testCatalog = discoverTsTests(projectFiles);
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
			if (!CODE_EXTENSION.test(file.path) || TS_TEST_FILE.test(file.path)) {
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
			const instrument = await this.supervisor.run("node", instrumentArgs, {
				cwd: session.root,
				signal,
				limits: {
					timeoutMs: 10_000,
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
					source: "tslive-instrument",
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
					source: "tslive-instrument",
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
					source: "tslive-instrument",
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
						source: "tslive-instrument",
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

		// Type checking surfaces diagnostics but never blocks the run: node
		// strips types regardless, matching the language's semantics.
		callbacks.state("compiling");
		const tscEntry = join(
			PROJECT_ROOT,
			"node_modules",
			"typescript",
			"bin",
			"tsc",
		);
		const typecheck = await this.supervisor.run(
			"node",
			[
				tscEntry,
				"-p",
				join(session.root, "tsconfig.json"),
				"--pretty",
				"false",
			],
			{
				cwd: session.root,
				signal,
				limits: {
					timeoutMs: TSC_TIMEOUT_MS,
					stdoutBytes: 2 * 1024 * 1024,
					stderrBytes: 512 * 1024,
				},
			},
		);
		metrics.compilationMs = typecheck.durationMs;
		if (typecheck.cancelled || signal.aborted)
			return {
				terminalState: "cancelled",
				result: { ...metrics, cancelled: true, reason: "superseded" },
			};
		callbacks.diagnostic(
			"compiler",
			parseTscDiagnostics(`${typecheck.stdout}\n${typecheck.stderr}`),
		);

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
		const runtimeModule = join(
			session.root,
			"generated",
			"__ziglive_runtime.mjs",
		);
		const entry = join(session.root, "generated", "main.ts");
		const execution = await this.supervisor.run(
			"node",
			["--import", `file://${runtimeModule}`, entry],
			{
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
			const location =
				/(?:generated|src)[/\\]([\w./-]+\.(?:ts|js|mjs|cjs)):(\d+)(?::(\d+))?/.exec(
					execution.stderr,
				);
			callbacks.diagnostic("runtime", [
				{
					...(location?.[1] ? { path: `src/${location[1]}` } : {}),
					message: "Program threw or exited abnormally",
					severity: "error",
					line: Number(location?.[2] ?? 1),
					column: Number(location?.[3] ?? 1),
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
		const testFiles = [
			...new Set(
				catalog.map((test) =>
					join(session.root, test.path.replace(/^src\//, "src/")),
				),
			),
		];
		const execution = await this.supervisor.run(
			"node",
			["--test", "--test-reporter=tap", ...testFiles],
			{
				cwd: join(session.root, "src"),
				signal,
				limits: {
					timeoutMs: Math.max(settings.timeoutMs + 5000, 10_000),
					stdoutBytes: 2 * 1024 * 1024,
					stderrBytes: 512 * 1024,
				},
			},
		);
		if (execution.cancelled || signal.aborted) return;
		const results = parseTapOutput(execution.stdout);
		if (!results.length && execution.exitCode !== 0)
			callbacks.output("stderr", execution.stderr, "error");
		const counts = { passed: 0, failed: 0, skipped: 0 };
		const reported = new Set<string>();
		for (const result of results) {
			counts[result.status]++;
			const matched = catalog.find(
				(candidate) => candidate.name === result.name,
			);
			if (matched) reported.add(matched.testId);
			callbacks.testResult({
				...(matched ? { testId: matched.testId } : {}),
				name: result.name,
				status: result.status,
				durationMs: result.durationMs,
				...(result.message ? { message: result.message } : {}),
			});
		}
		if (execution.timedOut) {
			for (const test of catalog) {
				if (reported.has(test.testId)) continue;
				counts.failed++;
				callbacks.testResult({
					testId: test.testId,
					name: test.name,
					status: "timed_out",
					durationMs: 0,
				});
			}
		}
		callbacks.testSummary({
			...counts,
			leaked: 0,
			durationMs: execution.durationMs,
		});
	}
}
