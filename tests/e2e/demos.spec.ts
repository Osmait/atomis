import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CreateSessionResponse, Language } from "../../packages/protocol/src/index.js";

/**
 * Every demo, run for real: opened the way the gallery opens it (its files
 * in a new scratch session) and answered from the Input. A toolchain upgrade
 * that breaks a demo fails here, not in front of a user.
 */

const ENTRY: Record<Language, string> = {
	zig: "main.zig",
	rust: "main.rs",
	go: "main.go",
	ts: "main.ts",
	py: "main.py",
	c: "main.c",
	cpp: "main.cpp",
};

/** A new scratch session holding the demo, or a skip where it cannot run. */
async function openDemo(
	request: APIRequestContext,
	baseURL: string,
	demo: string,
	language: Language,
): Promise<CreateSessionResponse> {
	// Specs are transpiled to CJS (no import.meta); the suite runs from the
	// repository root, as security.spec does.
	const entry = ENTRY[language];
	const source = readFileSync(resolvePath(process.cwd(), "demos", demo, entry), "utf8");
	const response = await request.post("/api/sessions", {
		headers: { origin: baseURL },
		data: { language, files: [{ path: entry, source }] },
	});
	expect(response.ok()).toBe(true);
	const created = (await response.json()) as CreateSessionResponse;
	const runner = created.toolchains[language]?.run;
	test.skip(!runner || runner === "unavailable", `${language} is not installed here`);
	return created;
}

/**
 * Runs the program once per input, in order, in the same session — what one
 * run leaves on disk, the next one finds — and returns each run's output.
 */
async function runEach(page: Page, created: CreateSessionResponse, inputs: string[]): Promise<string[]> {
	await page.goto("/api/health");
	const outputs = await page.evaluate(
		async ({ session, inputs: pending }) => {
			const url = new URL("/ws/runtime", location.href);
			url.protocol = "ws:";
			url.searchParams.set("sessionId", session.sessionId);
			url.searchParams.set("token", session.authToken);
			const socket = new WebSocket(url);
			const byRun = new Map<string, string>();
			const finished: string[] = [];
			let runEnded: (() => void) | undefined;
			socket.addEventListener("message", (event) => {
				const message = JSON.parse(String(event.data)) as {
					type: string;
					documentVersion?: number;
					runId?: string;
					chunk?: string;
				};
				if (message.documentVersion !== 2) return;
				if (message.type === "output" && message.runId)
					byRun.set(message.runId, (byRun.get(message.runId) ?? "") + (message.chunk ?? ""));
				if (message.type === "run.finished" && message.runId) {
					finished.push(message.runId);
					runEnded?.();
				}
			});
			await new Promise((resolve) => {
				socket.addEventListener("open", resolve, { once: true });
			});
			const send = (message: object): void =>
				socket.send(JSON.stringify({ sessionId: session.sessionId, ...message }));
			send({ type: "settings.update", autoRun: false, autoInspect: true, debounceMs: 150, timeoutMs: 10000, manualProbeIds: [] });
			// A no-op edit gives these runs their own version, past the one
			// the session ran on attach.
			send({ type: "document.update", version: 2, path: session.files[0]!.path, source: session.files[0]!.source });
			// Armed before each request, so the run cannot finish unseen.
			const nextRun = (): Promise<void> =>
				new Promise((resolve) => {
					runEnded = resolve;
				});
			for (const input of pending) {
				const ran = nextRun();
				send({ type: "input.update", text: input });
				send({ type: "run.request", version: 2, reason: "manual" });
				await ran;
			}
			socket.close();
			return finished.map((runId) => byRun.get(runId) ?? "");
		},
		{ session: created, inputs },
	);
	// The e2e server runs with FORCE_COLOR, which Node honours when it
	// prints a number; the terminal strips colour the same way.
	// eslint-disable-next-line no-control-regex
	return outputs.map((output) => output.replaceAll(/\u001B\[[0-9;]*m/g, "").trim());
}

for (const language of Object.keys(ENTRY) as Language[]) {
	test(`the calculator REPL demo runs in ${language}`, async ({ page, request, baseURL }) => {
		const created = await openDemo(request, baseURL!, "repl", language);
		const [output] = await runEach(page, created, ["2 + 3\n10 / 4\n7 / 0\nnope\nsum\nquit\n"]);
		expect(output).toBe(
			[
				"Tiny calculator. Try 2 + 3, or: help, sum, quit",
				"> 5",
				"> 2.5",
				"> ? can't divide by zero",
				"> ? expected: <number> <op> <number>",
				"> total of 2 results: 7.5",
				"> bye",
			].join("\n"),
		);
	});

	test(`the mini Redis demo keeps its data across runs in ${language}`, async ({ page, request, baseURL }) => {
		const created = await openDemo(request, baseURL!, "redis", language);
		const [first, second, third] = await runEach(page, created, [
			"SET name Ada Lovelace\nGET name\nINCR visits\nINCR visits\nSET counter abc\nINCR counter\nEXISTS name\nDEL counter\nDEL counter\nKEYS\nDBSIZE\nget nothing\nFOO bar\nGET\nQUIT\n",
			// A new process: everything it knows comes from the log file.
			"GET name\nINCR visits\nKEYS\nFLUSHALL\nDBSIZE\nKEYS\nQUIT\n",
			"DBSIZE\n",
		]);
		const ready = "mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT";
		expect(first).toBe(
			[
				"loaded 0 keys (0 log entries) from redis.aof",
				ready,
				"redis> OK",
				'redis> "Ada Lovelace"',
				"redis> (integer) 1",
				"redis> (integer) 2",
				"redis> OK",
				"redis> (error) ERR value is not an integer or out of range",
				"redis> (integer) 1",
				"redis> (integer) 1",
				"redis> (integer) 0",
				'redis> 1) "name"',
				'2) "visits"',
				"redis> (integer) 2",
				"redis> (nil)",
				"redis> (error) ERR unknown command 'FOO'",
				"redis> (error) ERR wrong number of arguments for 'get'",
				"redis> bye",
			].join("\n"),
		);
		// Replayed from five log entries (two SETs of visits, the counter
		// set and deleted) into two keys, then compacted.
		expect(second).toBe(
			[
				"loaded 2 keys (5 log entries) from redis.aof",
				ready,
				'redis> "Ada Lovelace"',
				"redis> (integer) 3",
				'redis> 1) "name"',
				'2) "visits"',
				"redis> OK",
				"redis> (integer) 0",
				"redis> (empty array)",
				"redis> bye",
			].join("\n"),
		);
		// FLUSHALL was logged too: the compacted two SETs, the INCR, then it.
		// End of input with no QUIT ends the REPL just the same.
		expect(third).toBe(
			["loaded 0 keys (4 log entries) from redis.aof", ready, "redis> (integer) 0", "redis> bye"].join("\n"),
		);
	});
}
