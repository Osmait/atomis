#!/usr/bin/env node
// Load test and resource profile: what a deployment of this server would
// cost to keep up, measured the way a container platform bills it.
//
// Railway (and most hosts like it) bill the container's cgroup: CPU time
// actually used and memory actually resident, including every compiler,
// program and language server the server spawns. A process-level RSS of the
// server alone would miss nearly all of it — the server idles at 7MB while
// a single rust-analyzer can hold hundreds. So the server here runs in a
// cgroup of its own (`systemd-run --user --scope`), sampled once a second,
// optionally capped to the size of the plan being considered.
//
//   node scripts/loadtest.mjs [--languages zig,py] [--stages 1,2,4,8]
//       [--stage-seconds 45] [--think-ms 3000] [--runs 8] [--lsp]
//       [--cpus 2] [--memory 2G] [--out bench/load-latest.json]
//       [--server <binary>] [--perf <perf.data>] [--perf-period-us 5000]
//       [--trace <trace.json>]
//
// --trace has the server write a span timeline (ATOMIS_TRACE) and adds the
// client's side of every run — request sent, result received, on the same
// clock — as <trace>.client.json; scripts/trace-report.py joins the two.
//
// --perf records the whole process tree with `perf record` (DWARF call
// graphs, user space only) for flame graphs: the server and every compiler,
// program and language server it starts. It samples every N µs of each
// thread's CPU time rather than at a frequency: perf's frequency mode starts
// every new thread at the shortest period, so the many short-lived processes
// here (a linker with a thread per core, alive 10 ms) came out with hundreds
// of samples each and dwarfed everything that actually used the CPU. Pair it with a server built with
// symbols and frame pointers (see docs/railway.md, "Profiling").
//
// Like bench.mjs it starts a server it owns, with its own preferences,
// workspaces and session directory — never the running instance, whose
// settings sync to every device. Sessions go to a directory on disk rather
// than /tmp: on a desktop /tmp is usually tmpfs, where every build artifact
// would be counted as memory, and a container's /tmp is not.

/* eslint-disable no-await-in-loop -- The profile phases are sequential on
   purpose: each one measures a single thing against an otherwise quiet
   cgroup. The concurrent part is the stages, and that concurrency is
   explicit. */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(name);

const PORT = Number(flag("--port", "4472"));
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = flag("--languages", "");
const STAGES = flag("--stages", "1,2,4,8").split(",").map(Number);
const STAGE_SECONDS = Number(flag("--stage-seconds", "45"));
const THINK_MS = Number(flag("--think-ms", "3000"));
const PROFILE_RUNS = Number(flag("--runs", "8"));
const CPUS = flag("--cpus", "");
const MEMORY = flag("--memory", "");
const OUT = flag("--out", "bench/load-latest.json");
const WITH_LSP = has("--lsp");
const SERVER = flag("--server", join(root, "apps/server-rs/target/release/atomis-server"));
const PERF = flag("--perf", "");
const PERF_PERIOD_NS = String(Number(flag("--perf-period-us", "5000")) * 1000);
const TRACE = flag("--trace", "");
/** What the client saw of each run, for the trace: {run, language, sent, received} in Unix µs. */
const clientRuns = [];
/** Unix microseconds: the clock the server stamps its spans with. */
const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);
const HEADERS = { origin: BASE };

const ENTRY = { zig: "zig", ts: "ts", py: "py", go: "go", rust: "rs", c: "c", cpp: "cpp" };
const COMMENT = { py: "#" };
const LSP_LANGUAGE_ID = { zig: "zig", ts: "typescript", py: "python", go: "go", rust: "rust", c: "c", cpp: "cpp" };

const round = (value, places = 1) => {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
};
const percentile = (values, p) => {
	if (!values.length) return null;
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const mb = (bytes) => round(bytes / 1048576);

// ── the cgroup ───────────────────────────────────────────────────────────

/** Reads what the platform would bill: cumulative CPU and resident memory. */
function readCgroup(path) {
	const stat = Object.fromEntries(
		readFileSync(join(path, "memory.stat"), "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split(" "))
			.map(([key, value]) => [key, Number(value)]),
	);
	const usageUsec = Number(readFileSync(join(path, "cpu.stat"), "utf8").match(/usage_usec (\d+)/)[1]);
	return {
		cpuSeconds: usageUsec / 1e6,
		memoryBytes: Number(readFileSync(join(path, "memory.current"), "utf8")),
		anonBytes: stat.anon,
		fileBytes: stat.file,
		pids: Number(readFileSync(join(path, "pids.current"), "utf8")),
	};
}

/** Samples the cgroup once a second, tagging each sample with the phase. */
function startSampler(path) {
	const started = performance.now();
	let last = readCgroup(path);
	let lastAt = started;
	const sampler = {
		path,
		samples: [],
		phase: "startup",
		/** Memory and CPU from now until the returned function is called. */
		window(phase) {
			sampler.phase = phase;
			const from = readCgroup(path);
			const firstSample = sampler.samples.length;
			return () => {
				const to = readCgroup(path);
				const inWindow = sampler.samples.slice(firstSample);
				return {
					cpuSeconds: to.cpuSeconds - from.cpuSeconds,
					peakMemoryMb: Math.max(mb(to.memoryBytes), ...inWindow.map((s) => s.memoryMb)),
					peakAnonMb: Math.max(mb(to.anonBytes), ...inWindow.map((s) => s.anonMb)),
					endMemoryMb: mb(to.memoryBytes),
					endAnonMb: mb(to.anonBytes),
				};
			};
		},
		stop() {
			clearInterval(timer);
		},
	};
	const timer = setInterval(() => {
		const now = performance.now();
		const current = readCgroup(path);
		const cores = (current.cpuSeconds - last.cpuSeconds) / ((now - lastAt) / 1000);
		sampler.samples.push({
			t: round((now - started) / 1000),
			phase: sampler.phase,
			cores: round(cores, 3),
			memoryMb: mb(current.memoryBytes),
			anonMb: mb(current.anonBytes),
			pids: current.pids,
		});
		last = current;
		lastAt = now;
	}, 1000);
	return sampler;
}

// ── the server ───────────────────────────────────────────────────────────

async function startServer() {
	const dataDir = mkdtempSync(join(homedir(), ".cache", "atomis-loadtest-"));
	mkdirSync(join(dataDir, "tmp"));
	const properties = ["-p", "MemoryAccounting=yes", "-p", "CPUAccounting=yes"];
	if (CPUS) properties.push("-p", `CPUQuota=${Number(CPUS) * 100}%`);
	if (MEMORY) properties.push("-p", `MemoryMax=${MEMORY}`, "-p", "MemorySwapMax=0");
	const unit = `atomis-loadtest-${process.pid}`;
	const server = spawn(
		"systemd-run",
		[
			"--user",
			"--scope",
			"--quiet",
			"--unit",
			unit,
			...properties,
			...(PERF
				? ["perf", "record", "--quiet", "-e", "task-clock:u", "-c", PERF_PERIOD_NS, "--call-graph", "dwarf,16384", "-o", PERF, "--"]
				: []),
			SERVER,
		],
		{
			env: {
				...process.env,
				NODE_ENV: "production",
				ATOMIS_ROOT: root,
				ATOMIS_WEB_DIST: join(root, "apps/web/dist"),
				ATOMIS_PORT: String(PORT),
				ATOMIS_PREFERENCES: join(dataDir, "preferences.json"),
				ATOMIS_WORKSPACES: join(dataDir, "workspaces"),
				TMPDIR: join(dataDir, "tmp"),
				XDG_CACHE_HOME: join(dataDir, "cache"),
				RUST_LOG: "warn",
				...(TRACE ? { ATOMIS_TRACE: TRACE } : {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const log = [];
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`server never announced a port\n${log.join("")}`)), 30_000);
		const onData = (chunk) => {
			log.push(String(chunk));
			if (String(chunk).includes("ATOMIS_LISTENING=")) {
				clearTimeout(timer);
				resolve();
			}
		};
		server.stdout.on("data", onData);
		server.stderr.on("data", onData);
		server.on("exit", (code) => reject(new Error(`server exited with ${code}\n${log.join("")}`)));
	});
	// `systemd-run --scope` execs the command in place, so this pid is the
	// server itself and its cgroup is the scope.
	const cgroup = readFileSync(`/proc/${server.pid}/cgroup`, "utf8").trim().split("::")[1];
	return { server, dataDir, cgroupPath: join("/sys/fs/cgroup", cgroup) };
}

// ── one simulated person ─────────────────────────────────────────────────

/** A session plus its runtime socket, driven the way the editor drives it. */
class Client {
	static async open(language) {
		const response = await fetch(`${BASE}/api/sessions`, {
			method: "POST",
			headers: { ...HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ language, scaffold: "minimal" }),
		});
		if (!response.ok) throw new Error(`POST /api/sessions ${response.status}: ${await response.text()}`);
		const session = await response.json();
		const entry = session.files.find((file) => file.path === `src/main.${ENTRY[language]}`) ?? session.files[0];
		const client = new Client(language, session, entry);
		await client.connect();
		return client;
	}

	constructor(language, session, entry) {
		this.language = language;
		this.session = session;
		this.entry = entry;
		this.version = 1;
		this.edits = 0;
		this.waiting = new Map();
	}

	async connect() {
		const query = new URLSearchParams({ sessionId: this.session.sessionId, token: this.session.authToken });
		this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws/runtime?${query}`, { headers: HEADERS });
		await new Promise((resolve, reject) => {
			this.socket.addEventListener("open", resolve, { once: true });
			this.socket.addEventListener("error", () => reject(new Error("runtime socket failed")), { once: true });
		});
		this.socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.type === "project.files") this.version = Math.max(this.version, message.documentVersion);
			if (message.type === "server.error") console.error(`server.error (${this.language}): ${message.message} ${message.details ?? ""}`);
			if (process.env.LOADTEST_DEBUG && (message.type === "diagnostics" || message.type === "output") && JSON.stringify(message).length > 120)
				console.error(`${this.language} ${message.type}:`, JSON.stringify(message).slice(0, 400));
			if (message.type === "run.finished") {
				const resolve = this.waiting.get(message.documentVersion);
				this.waiting.delete(message.documentVersion);
				resolve?.({ result: message.result, runId: message.runId, at: nowUs() });
			}
		});
		// Manual runs only: with Auto Run on, the edit below would start a
		// run of its own after the debounce, and every sample would be two.
		this.send({
			type: "settings.update",
			sessionId: this.session.sessionId,
			autoRun: false,
			autoInspect: true,
			// The server accepts 300-500 and rejects the whole message
			// otherwise, which would leave Auto Run on.
			debounceMs: 300,
			timeoutMs: 10_000,
			manualProbeIds: [],
		});
	}

	send(message) {
		this.socket.send(JSON.stringify(message));
	}

	/**
	 * One keystroke's worth of work: a changed document, then a run of it.
	 * The edit is real — a fresh comment each time — so no layer can answer
	 * from a cache that a person typing would never hit.
	 */
	async editAndRun() {
		this.version += 1;
		this.edits += 1;
		const version = this.version;
		const comment = COMMENT[this.language] ?? "//";
		this.send({
			type: "document.update",
			sessionId: this.session.sessionId,
			version,
			path: this.entry.path,
			source: `${this.entry.source}\n${comment} load ${this.edits}\n`,
		});
		const started = performance.now();
		const finished = new Promise((resolve) => {
			this.waiting.set(version, resolve);
		});
		const sent = nowUs();
		this.send({ type: "run.request", sessionId: this.session.sessionId, version, reason: "manual" });
		const timeout = sleep(60_000).then(() => null);
		const answer = await Promise.race([finished, timeout]);
		if (TRACE && answer)
			clientRuns.push({ run: answer.runId.slice(0, 8), language: this.language, sent, received: answer.at });
		return { ms: performance.now() - started, result: answer?.result ?? null };
	}

	close() {
		this.socket.close();
	}
}

/**
 * Opens the editor's language server for this session, the way the editor
 * does: initialize, open the entry file, then ask for its symbols — the
 * answer to that is the point at which the editor's features work.
 */
async function openLsp(client) {
	const query = new URLSearchParams({
		sessionId: client.session.sessionId,
		token: client.session.authToken,
		lang: client.language,
	});
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws/lsp?${query}`, { headers: HEADERS });
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("lsp socket failed")), { once: true });
	});
	const answered = new Set();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if (process.env.LOADTEST_DEBUG) console.error("lsp <", String(event.data).slice(0, 200));
		if (message.id !== undefined && message.method === undefined) answered.add(message.id);
	});
	const until = async (id, ms) => {
		const deadline = performance.now() + ms;
		while (!answered.has(id) && performance.now() < deadline) await sleep(50);
		return answered.has(id);
	};
	const request = (id, method, params) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
	const notify = (method, params) => socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	// The session directory: the entry file's URI minus its project path.
	const rootUri = client.entry.uri.slice(0, client.entry.uri.length - client.entry.path.length - 1);
	const started = performance.now();
	request(1, "initialize", {
		processId: null,
		rootUri,
		capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
		workspaceFolders: [{ uri: rootUri, name: "load" }],
	});
	const initialized = await until(1, 60_000);
	const initializeMs = performance.now() - started;
	notify("initialized", {});
	notify("textDocument/didOpen", {
		textDocument: { uri: client.entry.uri, languageId: LSP_LANGUAGE_ID[client.language], version: 1, text: client.entry.source },
	});
	request(2, "textDocument/documentSymbol", { textDocument: { uri: client.entry.uri } });
	const ready = await until(2, 90_000);
	return { socket, initialized, ready, initializeMs, readyMs: performance.now() - started };
}

/** Waits until the cgroup's anonymous memory stops moving, so a delta means something. */
async function settle(path, maxMs = 45_000) {
	const deadline = performance.now() + maxMs;
	let previous = readCgroup(path).anonBytes;
	while (performance.now() < deadline) {
		await sleep(3000);
		const current = readCgroup(path).anonBytes;
		if (Math.abs(current - previous) < 3 * 1048576) return current;
		previous = current;
	}
	return readCgroup(path).anonBytes;
}

// ── phases ───────────────────────────────────────────────────────────────

/**
 * Per language, alone: the cold first run, then back-to-back warm runs.
 * CPU-seconds per warm run is the number a cost model is built on.
 */
async function profileLanguage(sampler, language) {
	const client = await Client.open(language);
	let stop = sampler.window(`profile:${language}:cold`);
	const cold = await client.editAndRun();
	const coldUsage = stop();
	stop = sampler.window(`profile:${language}:warm`);
	const warm = [];
	let failures = 0;
	let last = null;
	for (let i = 0; i < PROFILE_RUNS; i += 1) {
		const run = await client.editAndRun();
		warm.push(run.ms);
		last = run.result ?? last;
		if (!run.result || run.result.exitCode !== 0 || run.result.timedOut) failures += 1;
	}
	const warmUsage = stop();
	const result = last;
	client.close();
	return {
		coldRunMs: round(cold.ms),
		coldCpuSeconds: round(coldUsage.cpuSeconds, 3),
		coldOk: Boolean(cold.result && cold.result.exitCode === 0),
		warmRunP50Ms: round(percentile(warm, 50)),
		warmRunP95Ms: round(percentile(warm, 95)),
		cpuSecondsPerRun: round(warmUsage.cpuSeconds / PROFILE_RUNS, 4),
		peakMemoryMb: Math.max(coldUsage.peakMemoryMb, warmUsage.peakMemoryMb),
		peakAnonMb: Math.max(coldUsage.peakAnonMb, warmUsage.peakAnonMb),
		failures,
		lastBreakdown: result && {
			instrumentationMs: round(result.instrumentationMs),
			compilationMs: round(result.compilationMs),
			executionMs: round(result.executionMs),
		},
	};
}

/**
 * Memory held by an open editor tab's language server, one language at a
 * time and cumulatively: a closed language server outlives its socket by
 * the reconnect grace, so closing each before measuring the next would
 * charge the next with the previous one's exit. Kept open, each delta is
 * that server alone — and the total is what one tab per language holds.
 */
async function profileLsp(sampler, languages) {
	const open = [];
	const results = {};
	await sleep(1500);
	let baseline = await settle(sampler.path);
	const idleAnon = baseline;
	for (const language of languages) {
		const stop = sampler.window(`lsp:${language}`);
		try {
			const client = await Client.open(language);
			const lsp = await openLsp(client);
			open.push(client, lsp.socket);
			// Indexing goes on after the first answer; wait for it to finish.
			const held = await settle(sampler.path);
			const usage = stop();
			results[language] = {
				initializeMs: round(lsp.initializeMs),
				readyMs: round(lsp.readyMs),
				ready: lsp.ready,
				cpuSeconds: round(usage.cpuSeconds, 2),
				heldAnonMb: mb(held - baseline),
				peakMemoryMb: usage.peakMemoryMb,
			};
			baseline = held;
		} catch (error) {
			stop();
			results[language] = { error: String(error) };
		}
	}
	const totalHeldAnonMb = mb(baseline - idleAnon);
	for (const socket of open) socket.close();
	return { languages: results, totalHeldAnonMb };
}

/** N people editing and running at once, each with a think time between runs. */
async function stage(sampler, concurrency, languages) {
	const clients = await Promise.all(
		Array.from({ length: concurrency }, (_, index) => Client.open(languages[index % languages.length])),
	);
	const stop = sampler.window(`stage:${concurrency}`);
	const stageStarted = performance.now();
	const deadline = performance.now() + STAGE_SECONDS * 1000;
	const runs = [];
	await Promise.all(
		clients.map(async (client) => {
			// Stagger the starts so the stage does not open with N
			// simultaneous compiles that no real group of people produces.
			await sleep(Math.random() * THINK_MS);
			while (performance.now() < deadline) {
				const run = await client.editAndRun();
				runs.push({
					language: client.language,
					ms: run.ms,
					ok: Boolean(run.result && run.result.exitCode === 0 && !run.result.timedOut),
					lost: !run.result,
				});
				// Exponential think time: the gaps between a person's runs
				// are irregular, and irregular arrivals are what queue.
				await sleep(-Math.log(1 - Math.random()) * THINK_MS);
			}
		}),
	);
	const usage = stop();
	for (const client of clients) client.close();
	const elapsed = (performance.now() - stageStarted) / 1000;
	const byLanguage = {};
	for (const language of languages) {
		const own = runs.filter((run) => run.language === language).map((run) => run.ms);
		if (own.length) byLanguage[language] = { runs: own.length, p50Ms: round(percentile(own, 50)), p95Ms: round(percentile(own, 95)) };
	}
	const all = runs.map((run) => run.ms);
	return {
		concurrency,
		runs: runs.length,
		runsPerMinute: round((runs.length / elapsed) * 60),
		failures: runs.filter((run) => !run.ok).length,
		lost: runs.filter((run) => run.lost).length,
		p50Ms: round(percentile(all, 50)),
		p95Ms: round(percentile(all, 95)),
		p99Ms: round(percentile(all, 99)),
		avgCores: round(usage.cpuSeconds / elapsed, 3),
		cpuSecondsPerRun: runs.length ? round(usage.cpuSeconds / runs.length, 4) : null,
		peakMemoryMb: usage.peakMemoryMb,
		peakAnonMb: usage.peakAnonMb,
		byLanguage,
	};
}

// ── main ─────────────────────────────────────────────────────────────────

if (!existsSync(SERVER)) {
	console.error("No release server: run `pnpm build` first.");
	process.exit(1);
}

const { server, dataDir, cgroupPath } = await startServer();
const sampler = startSampler(cgroupPath);
let report;
try {
	const doctor = await (await fetch(`${BASE}/api/doctor`, { headers: HEADERS })).json();
	const ok = new Set(doctor.checks.filter((check) => check.ok).map((check) => check.name));
	// The doctor passes a missing language server — it is optional, the
	// session merely degrades — so presence is read from what it detected.
	const present = new Set(
		doctor.checks.filter((check) => check.ok && !/No such file|not found/i.test(check.detected)).map((check) => check.name),
	);
	const toolchains = [
		["zig", "Zig compiler", "ZLS language server"],
		["ts", "Node.js", "TS typescript-language-server"],
		["py", "Python python3", "Python pyright"],
		["go", "Go go", "Go gopls"],
		["rust", "Rust rustc", "Rust rust-analyzer"],
		["cpp", "C/C++ clang++", "C/C++ clangd"],
	].filter(([id]) => !ONLY || ONLY.split(",").includes(id));
	const languages = toolchains.filter(([, run]) => ok.has(run)).map(([id]) => id);
	const lspLanguages = toolchains.filter(([, run, lsp]) => ok.has(run) && present.has(lsp)).map(([id]) => id);
	console.error(`languages: ${languages.join(", ")}${WITH_LSP ? ` · lsp: ${lspLanguages.join(", ")}` : ""}`);

	console.error("idle (20s)…");
	let stop = sampler.window("idle");
	await sleep(20_000);
	const idleUsage = stop();
	const idle = {
		memoryMb: idleUsage.endMemoryMb,
		anonMb: idleUsage.endAnonMb,
		cores: round(idleUsage.cpuSeconds / 20, 4),
	};

	const profile = {};
	for (const language of languages) {
		console.error(`profile ${language}…`);
		profile[language] = await profileLanguage(sampler, language);
	}

	let lsp = null;
	if (WITH_LSP) {
		console.error(`lsp ${lspLanguages.join(", ")}…`);
		lsp = await profileLsp(sampler, lspLanguages);
		// The closed language servers outlive their sockets by the
		// reconnect grace; the stages should not be billed for them.
		console.error("waiting out the reconnect grace (125s)…");
		const stopGrace = sampler.window("lsp:grace");
		await sleep(125_000);
		stopGrace();
	}

	const stages = [];
	for (const concurrency of STAGES) {
		console.error(`stage ${concurrency} concurrent (${STAGE_SECONDS}s)…`);
		stages.push(await stage(sampler, concurrency, languages));
		// Let the stage's sessions finish tearing down before the next one,
		// so its memory is not billed to the next.
		stop = sampler.window(`cooldown:${concurrency}`);
		await sleep(5000);
		stop();
	}

	stop = sampler.window("after");
	await sleep(3000);
	const after = stop();

	report = {
		takenAt: new Date().toISOString(),
		commit: process.env.BENCH_COMMIT ?? "",
		host: { cpus: (await import("node:os")).cpus().length, cpuModel: (await import("node:os")).cpus()[0]?.model },
		limits: { cpus: CPUS ? Number(CPUS) : null, memory: MEMORY || null },
		config: { stages: STAGES, stageSeconds: STAGE_SECONDS, thinkMs: THINK_MS, profileRuns: PROFILE_RUNS },
		idle,
		retainedAfterLoadMb: after.endMemoryMb,
		retainedAfterLoadAnonMb: after.endAnonMb,
		profile,
		lsp,
		stages,
		timeseries: sampler.samples,
	};
} finally {
	sampler.stop();
	// Under perf, perf is the process here: SIGINT makes it stop the server
	// and finish writing the profile, which must be waited for.
	server.kill(PERF ? "SIGINT" : "SIGTERM");
	if (PERF)
		await new Promise((resolve) => {
			server.once("exit", resolve);
		});
}

const outPath = isAbsolute(OUT) ? OUT : join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (TRACE) writeFileSync(`${TRACE}.client.json`, `${JSON.stringify(clientRuns)}\n`);
const { timeseries, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
console.log(`\nwrote ${OUT} (${timeseries.length} samples)`);
await sleep(500);
rmSync(dataDir, { recursive: true, force: true });
