#!/usr/bin/env node
// Runtime benchmarks, against a server this script owns.
//
// Never point a benchmark at the running instance: UI settings live on the
// server and sync to every device, so a script that toggles Auto Run changes
// what the tablet in the other room is showing. This one starts its own
// server on a spare port with its own preferences and workspaces, and takes
// it down at the end.
//
//   node scripts/bench.mjs [--out bench/<name>.json] [--runs 7]
//
// Numbers are medians of `--runs` samples unless the name says otherwise,
// because a single sample of anything that compiles is mostly noise.

/* eslint-disable no-await-in-loop -- Every loop here is a measurement.
   Running the samples concurrently would have them compete for the same CPU
   and compiler cache, which is precisely the thing being measured. */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
};
const RUNS = Number(flag("--runs", "7"));
const OUT = flag("--out", "bench/latest.json");
const PORT = Number(flag("--port", "4471"));
const ONLY = flag("--languages", "");
const BASE = `http://127.0.0.1:${PORT}`;
// The Origin guard trusts the server's own URL; a bare fetch sends no Origin
// at all, which only the read-only endpoints accept.
const ORIGIN = { origin: BASE };

const median = (values) => {
	const sorted = values.toSorted((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, p) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value) => Math.round(value * 10) / 10;
const kb = (bytes) => Math.round(bytes / 102.4) / 10;

/** Starts the server and resolves once it says which port it bound. */
async function startServer() {
	const dataDir = mkdtempSync(join(tmpdir(), "atomis-bench-"));
	const started = performance.now();
	const server = spawn(join(root, "apps/server-rs/target/release/atomis-server"), {
		env: {
			...process.env,
			NODE_ENV: "production",
			ATOMIS_ROOT: root,
			ATOMIS_WEB_DIST: join(root, "apps/web/dist"),
			ATOMIS_PORT: String(PORT),
			ATOMIS_PREFERENCES: join(dataDir, "preferences.json"),
			ATOMIS_WORKSPACES: join(dataDir, "workspaces"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const listening = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("server never announced a port")), 30_000);
		const onData = (chunk) => {
			if (String(chunk).includes("ATOMIS_LISTENING=")) {
				clearTimeout(timer);
				resolve(performance.now() - started);
			}
		};
		server.stdout.on("data", onData);
		server.stderr.on("data", onData);
		server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
	});
	return { server, startupMs: listening, dataDir };
}

/** Milliseconds for one request, with the response drained. */
async function timed(path, init = {}) {
	const started = performance.now();
	const response = await fetch(`${BASE}${path}`, {
		...init,
		headers: { ...ORIGIN, ...init.headers },
	});
	await response.arrayBuffer();
	return { ms: performance.now() - started, status: response.status };
}

async function measureApi() {
	const endpoints = {
		"GET /api/health": () => timed("/api/health"),
		"GET /api/preferences": () => timed("/api/preferences"),
		"GET /api/workspaces": () => timed("/api/workspaces"),
		"PUT /api/preferences": () =>
			timed("/api/preferences", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ preferences: { "bench.key": String(Math.random()) } }),
			}),
	};
	const out = {};
	for (const [name, call] of Object.entries(endpoints)) {
		const samples = [];
		let status = 0;
		for (let i = 0; i < 40; i += 1) {
			const result = await call();
			status = result.status;
			// The first few warm the path rather than measuring it.
			if (i >= 5) samples.push(result.ms);
		}
		out[name] = { p50: round(median(samples)), p95: round(percentile(samples, 95)), status };
	}
	return out;
}

/** What the UI costs to deliver: the bytes a first visit pulls. */
function measureBundle() {
	const assets = join(root, "apps/web/dist/assets");
	let js = 0;
	let jsGzip = 0;
	let css = 0;
	let cssGzip = 0;
	let files = 0;
	for (const name of readdirSync(assets)) {
		const path = join(assets, name);
		if (!statSync(path).isFile()) continue;
		const bytes = readFileSync(path);
		if (name.endsWith(".js")) {
			files += 1;
			js += bytes.length;
			jsGzip += gzipSync(bytes).length;
		} else if (name.endsWith(".css")) {
			css += bytes.length;
			cssGzip += gzipSync(bytes).length;
		}
	}
	return { jsKb: kb(js), jsGzipKb: kb(jsGzip), cssKb: kb(css), cssGzipKb: kb(cssGzip), jsFiles: files };
}

/** Resident memory of the server process, in MB. */
function serverRssMb(pid) {
	const status = readFileSync(`/proc/${pid}/status`, "utf8");
	const match = status.match(/VmRSS:\s+(\d+) kB/);
	return match ? Math.round(Number(match[1]) / 102.4) / 10 : null;
}

/**
 * The numbers a person actually waits on, taken in a real browser: how long
 * until the editor is usable, how long a run takes, and how long a keystroke
 * takes to show its value.
 */
async function measureFirstLoad() {
	const { chromium } = await import("@playwright/test");
	const browser = await chromium.launch();
	// A fresh context so nothing is cached: this is someone's first visit,
	// which on a tablet over the network is the visit that hurts.
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(BASE, { waitUntil: "load" });
	await page.locator(".monaco-editor").waitFor({ state: "visible", timeout: 60_000 });
	const measured = await page.evaluate(() => {
		const paint = performance.getEntriesByName("first-contentful-paint")[0];
		const resources = performance.getEntriesByType("resource");
		const navigation = performance.getEntriesByType("navigation")[0];
		return {
			fcpMs: paint ? Math.round(paint.startTime) : null,
			transferredKb:
				Math.round(
					(resources.reduce((total, entry) => total + entry.transferSize, 0) +
						(navigation?.transferSize ?? 0)) / 102.4,
				) / 10,
			// What the browser had to decompress and parse, compressed or not.
			decodedKb:
				Math.round(
					resources.reduce((total, entry) => total + entry.decodedBodySize, 0) / 102.4,
				) / 10,
			requests: resources.length,
		};
	});
	await browser.close();
	return measured;
}

async function measureBrowser(languages) {
	const { chromium } = await import("@playwright/test");
	const browser = await chromium.launch();
	const results = {};
	for (const language of languages) {
		const page = await browser.newPage();
		// Every run.state event, timestamped, straight off the socket.
		await page.addInitScript(() => {
			const runs = [];
			window.benchRuns = runs;
			window.benchFinished = [];
			const Original = WebSocket;
			class Traced extends Original {
				constructor(url, protocols) {
					super(url, protocols);
					this.addEventListener("message", (event) => {
						try {
							const message = JSON.parse(String(event.data));
							if (message.type === "run.state")
								runs.push({ state: message.state, at: performance.now() });
							// The server's own breakdown, so a wall-clock number
							// that looks too good can be checked against it.
							if (message.type === "run.finished")
								window.benchFinished.push(message.result);
						} catch {
							/* not ours */
						}
					});
				}
			}
			window.WebSocket = Traced;
		});
		// These settings live on the server, and the server's copy wins over
		// localStorage on load — writing them in the page would silently
		// measure whatever language ran first, six times over.
		await fetch(`${BASE}/api/preferences`, {
			method: "PUT",
			headers: { ...ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({
				preferences: {
					"atomis.language.v1": language,
					"atomis.scaffold.v1": "demo",
					// Vim mode is on by default, and in normal mode a typed
					// space is not an edit: the keystroke measure would hang.
					"atomis.vim-mode.v1": "false",
				},
			}),
		});
		await page.goto(BASE);
		await page.evaluate(() => localStorage.clear());

		const loadStarted = Date.now();
		await page.reload();
		await page.locator(".monaco-editor").waitFor({ state: "visible", timeout: 60_000 });
		const editorReadyMs = Date.now() - loadStarted;
		// The first run compiles from an empty cache: the worst wait there is.
		await page.locator(".state-succeeded").waitFor({ state: "visible", timeout: 180_000 });
		const firstRunReadyMs = Date.now() - loadStarted;

		const warm = [];
		for (let i = 0; i < RUNS; i += 1) {
			const before = await page.evaluate(() => window.benchRuns.length);
			const started = Date.now();
			await page.locator(".run-button").click();
			await page.waitForFunction(
				(seen) => window.benchRuns.slice(seen).some((run) => run.state === "succeeded"),
				before,
				{ timeout: 120_000 },
			);
			warm.push(Date.now() - started);
		}

		// Keystroke to inline value: the debounce is part of the wait, because
		// it is part of what the person sees.
		const keystroke = [];
		for (let i = 0; i < Math.min(RUNS, 5); i += 1) {
			const before = await page.evaluate(() => window.benchRuns.length);
			await page.locator(".monaco-editor").click();
			const started = Date.now();
			await page.keyboard.press("End");
			await page.keyboard.type(" ");
			await page.waitForFunction(
				(seen) => window.benchRuns.slice(seen).some((run) => run.state === "succeeded"),
				before,
				{ timeout: 120_000 },
			);
			keystroke.push(Date.now() - started);
		}

		// What the server says it spent, for the same runs.
		const finished = await page.evaluate(() => window.benchFinished);
		const part = (key) =>
			finished.length ? round(median(finished.map((result) => result[key]))) : null;
		// The file the run actually used. A benchmark that cannot say what it
		// measured is worse than no benchmark.
		const status = await page.locator(".global-status").innerText();
		const entry = status.match(/src\/[\w.]+/)?.[0] ?? "?";
		results[language] = {
			entry,
			editorReadyMs,
			firstRunReadyMs,
			warmRunMs: round(median(warm)),
			warmRunP95Ms: round(percentile(warm, 95)),
			keystrokeToValueMs: round(median(keystroke)),
			serverInstrumentMs: part("instrumentationMs"),
			serverCompileMs: part("compilationMs"),
			serverExecuteMs: part("executionMs"),
		};
		await page.close();
	}
	await browser.close();
	return results;
}

const { server, startupMs, dataDir } = await startServer();
let report;
try {
	const doctor = await (await fetch(`${BASE}/api/doctor`)).json();
	const available = new Set(
		doctor.checks.filter((check) => check.ok).map((check) => check.name),
	);
	const languages = [
		["zig", "Zig compiler"],
		["ts", "Node.js"],
		["py", "Python python3"],
		["go", "Go go"],
		["rust", "Rust rustc"],
		["cpp", "C/C++ clang++"],
	]
		.filter(([, check]) => available.has(check))
		.map(([id]) => id)
		.filter((id) => !ONLY || ONLY.split(",").includes(id));

	report = {
		takenAt: new Date().toISOString(),
		commit: process.env.BENCH_COMMIT ?? "",
		runs: RUNS,
		server: { startupMs: round(startupMs), rssMbIdle: serverRssMb(server.pid) },
		api: await measureApi(),
		bundle: measureBundle(),
		firstLoad: await measureFirstLoad(),
		browser: await measureBrowser(languages),
	};
	report.server.rssMbAfterWork = serverRssMb(server.pid);
} finally {
	server.kill("SIGTERM");
}

// An absolute --out means exactly where it says, not under the repo.
const outPath = isAbsolute(OUT) ? OUT : join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`\nescrito en ${OUT} (datos temporales en ${dataDir})`);
