import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type {
	DocumentSnapshot,
	ProbeDescriptor,
	RunResult,
	TestCase,
} from "@ziglive/protocol";
import type { Session, SessionSettings } from "../sessions/SessionManager.js";
import { parseCargoDiagnostics } from "../diagnostics/CargoDiagnostics.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";
import { ProbeEventReader } from "./ProbeEventReader.js";
import {
	resetGenerated,
	type RunnerCallbacks,
	type RunnerOutcome,
	type ProjectDiagnostic,
} from "./CompilerRunner.js";
import { createMarkerParser } from "./RuntimeOutputParser.js";
import { discoverRustTests, matchRustTestName } from "./RustTestDiscovery.js";
import {
	extractFailureMessages,
	findTestExecutable,
	parseLibtestLine,
	parseLibtestSummary,
} from "./RustTestOutput.js";

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

const COMPILE_TIMEOUT_MS = 60_000;

export class RustCompilerRunner {
	public constructor(
		private readonly supervisor: ProcessSupervisor,
		private readonly instrumenter: string,
	) {}

	private cargoEnv(root: string): Record<string, string> {
		return {
			CARGO_NET_OFFLINE: "true",
			CARGO_TARGET_DIR: join(root, "target"),
			CARGO_TERM_COLOR: "never",
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
		const testCatalog = discoverRustTests(projectFiles);
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
			if (extname(file.path).toLowerCase() !== ".rs") {
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
			if (file.path === "main.rs") instrumentArgs.push("--entry");
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
					source: "rustlive-instrument",
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
					source: "rustlive-instrument",
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
					source: "rustlive-instrument",
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
						source: "rustlive-instrument",
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
			"cargo",
			[
				"build",
				"--bin",
				"ziglive-session",
				"--message-format=json",
				"--quiet",
				"--offline",
			],
			{
				cwd: session.root,
				signal,
				env: this.cargoEnv(session.root),
				limits: {
					timeoutMs: COMPILE_TIMEOUT_MS,
					stdoutBytes: 8 * 1024 * 1024,
					stderrBytes: 512 * 1024,
				},
			},
		);
		metrics.compilationMs = compile.durationMs;
		if (compile.cancelled || signal.aborted)
			return {
				terminalState: "cancelled",
				result: { ...metrics, cancelled: true, reason: "superseded" },
			};
		const compileDiagnostics = parseCargoDiagnostics(compile.stdout);
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
		const executable = join(
			session.root,
			"target",
			"debug",
			"ziglive-session",
		);
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
				/panicked at (?:.*[/\\])?(?:generated|src)[/\\](.+?\.rs):(\d+):(\d+)/.exec(
					execution.stderr,
				);
			callbacks.diagnostic("runtime", [
				{
					...(location?.[1] ? { path: `src/${location[1]}` } : {}),
					message: "Program panicked or exited abnormally",
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
		const build = await this.supervisor.run(
			"cargo",
			[
				"test",
				"--bin",
				"ziglive-check",
				"--no-run",
				"--message-format=json",
				"--quiet",
				"--offline",
			],
			{
				cwd: session.root,
				signal,
				env: this.cargoEnv(session.root),
				limits: {
					timeoutMs: COMPILE_TIMEOUT_MS,
					stdoutBytes: 8 * 1024 * 1024,
					stderrBytes: 512 * 1024,
				},
			},
		);
		if (build.cancelled || signal.aborted) return;
		if (build.exitCode !== 0) {
			const diagnostics = parseCargoDiagnostics(build.stdout);
			if (diagnostics.length) callbacks.diagnostic("compiler", diagnostics);
			else callbacks.output("stderr", build.stderr, "error");
			callbacks.testSummary({
				passed: 0,
				failed: 0,
				skipped: 0,
				leaked: 0,
				durationMs: build.durationMs,
			});
			return;
		}
		const executable = findTestExecutable(build.stdout, "ziglive-check");
		if (!executable) {
			callbacks.output(
				"stderr",
				"test binary not found in cargo output\n",
				"error",
			);
			return;
		}
		const started = performance.now();
		const arrivals: { name: string; status: string; at: number }[] = [];
		let stdoutBuffer = "";
		let fullStdout = "";
		const execution = await this.supervisor.run(
			executable,
			["--test-threads=1"],
			{
				cwd: join(session.root, "src"),
				signal,
				limits: {
					timeoutMs: Math.max(settings.timeoutMs, 3000),
					stdoutBytes: 1024 * 1024,
					stderrBytes: 512 * 1024,
				},
				callbacks: {
					stdout: (chunk) => {
						fullStdout += chunk;
						stdoutBuffer += chunk;
						let newline = stdoutBuffer.indexOf("\n");
						while (newline >= 0) {
							const line = stdoutBuffer.slice(0, newline);
							stdoutBuffer = stdoutBuffer.slice(newline + 1);
							const parsed = parseLibtestLine(line);
							if (parsed)
								arrivals.push({ ...parsed, at: performance.now() });
							newline = stdoutBuffer.indexOf("\n");
						}
					},
				},
			},
		);
		if (execution.cancelled || signal.aborted) return;
		const messages = extractFailureMessages(fullStdout);
		const reported = new Set<string>();
		let previous = started;
		const localCounts = { passed: 0, failed: 0, skipped: 0 };
		for (const arrival of arrivals) {
			const matched = matchRustTestName(catalog, arrival.name);
			if (matched) reported.add(matched.testId);
			const status =
				arrival.status === "ok"
					? "passed"
					: arrival.status === "ignored"
						? "skipped"
						: "failed";
			localCounts[status]++;
			const message =
				status === "failed" ? messages.get(arrival.name) : undefined;
			callbacks.testResult({
				...(matched ? { testId: matched.testId } : {}),
				name: matched?.name ?? arrival.name,
				status,
				durationMs: Math.max(arrival.at - previous, 0),
				...(message ? { message } : {}),
			});
			previous = arrival.at;
		}
		if (execution.timedOut || execution.exitCode === null) {
			for (const test of catalog) {
				if (reported.has(test.testId)) continue;
				localCounts.failed++;
				callbacks.testResult({
					testId: test.testId,
					name: test.name,
					status: execution.timedOut ? "timed_out" : "failed",
					durationMs: 0,
				});
			}
		}
		const summary = parseLibtestSummary(fullStdout);
		callbacks.testSummary({
			passed: summary?.passed ?? localCounts.passed,
			failed: summary && !execution.timedOut ? summary.failed : localCounts.failed,
			skipped: summary?.ignored ?? localCounts.skipped,
			leaked: 0,
			durationMs: execution.durationMs,
		});
	}
}
