import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { expect, test } from "@playwright/test";
import type { CreateSessionResponse, Language } from "../../packages/protocol/src/index.js";

/**
 * Every demo, run for real: opened the way the gallery opens it (its files
 * and Input text in a new scratch session) and answered from the Input. A
 * toolchain upgrade that breaks a demo fails here, not in front of a user.
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

const INPUT = "2 + 3\n10 / 4\n7 / 0\nnope\nsum\nquit\n";
const TRANSCRIPT = [
	"Tiny calculator. Try 2 + 3, or: help, sum, quit",
	"> 5",
	"> 2.5",
	"> ? can't divide by zero",
	"> ? expected: <number> <op> <number>",
	"> total of 2 results: 7.5",
	"> bye",
].join("\n");

for (const [language, entry] of Object.entries(ENTRY) as [Language, string][]) {
	test(`the calculator REPL demo runs in ${language}`, async ({ page, request, baseURL }) => {
		// Specs are transpiled to CJS (no import.meta); the suite runs from
		// the repository root, as security.spec does.
		const source = readFileSync(resolvePath(process.cwd(), "demos/repl", entry), "utf8");
		const response = await request.post("/api/sessions", {
			headers: { origin: baseURL! },
			data: { language, files: [{ path: entry, source }], input: INPUT },
		});
		expect(response.ok()).toBe(true);
		const created = (await response.json()) as CreateSessionResponse;
		const run = created.toolchains[language]?.run;
		test.skip(!run || run === "unavailable", `${language} is not installed here`);
		expect(created.input).toBe(INPUT);

		await page.goto("/api/health");
		const output = await page.evaluate(async ({ session, entryPath }) => {
			const url = new URL("/ws/runtime", location.href);
			url.protocol = "ws:";
			url.searchParams.set("sessionId", session.sessionId);
			url.searchParams.set("token", session.authToken);
			const socket = new WebSocket(url);
			const chunks: string[] = [];
			const finished = new Promise<void>((resolve) => {
				socket.addEventListener("message", (event) => {
					const message = JSON.parse(String(event.data)) as { type: string; documentVersion?: number; chunk?: string };
					if (message.type === "output" && message.documentVersion === 2) chunks.push(message.chunk ?? "");
					if (message.type === "run.finished" && message.documentVersion === 2) resolve();
				});
			});
			await new Promise((resolve) => {
				socket.addEventListener("open", resolve, { once: true });
			});
			const send = (message: object) => socket.send(JSON.stringify({ sessionId: session.sessionId, ...message }));
			send({ type: "settings.update", autoRun: false, autoInspect: true, debounceMs: 150, timeoutMs: 10000, manualProbeIds: [] });
			// A no-op edit to give the run its own version.
			send({ type: "document.update", version: 2, path: entryPath, source: session.files[0]!.source });
			send({ type: "run.request", version: 2, reason: "manual" });
			await finished;
			socket.close();
			return chunks.join("");
		}, { session: created, entryPath: entry });
		// The e2e server runs with FORCE_COLOR, which Node honours when it
		// prints a number; the terminal strips colour the same way.
		// eslint-disable-next-line no-control-regex
		expect(output.replaceAll(/\u001B\[[0-9;]*m/g, "").trim()).toBe(TRANSCRIPT);
	});
}
