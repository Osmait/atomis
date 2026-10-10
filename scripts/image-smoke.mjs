#!/usr/bin/env node
// Smoke test for a running Atomis image: one real run per language.
//
//   node scripts/image-smoke.mjs <base-url> [token]
//
// Building the image proves nothing about what it can run. A toolchain the
// server judges too old (bookworm's clang 14, a Node without type stripping)
// switches its language off, and a session asked for in that language comes
// back silently in another one — so this checks the language of every
// session it gets before trusting the run, then that the run succeeded and
// reported probe values. Exits non-zero naming what failed.

const LANGUAGES = {
	zig: "main.zig",
	rust: "main.rs",
	go: "main.go",
	ts: "main.ts",
	py: "main.py",
	c: "main.c",
	cpp: "main.cpp",
};
const RUN_TIMEOUT_MS = 180_000;

const [base, token] = process.argv.slice(2);
if (!base) {
	console.error("usage: node scripts/image-smoke.mjs <base-url> [token]");
	process.exit(2);
}
const headers = {
	origin: base,
	"content-type": "application/json",
	...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function runOnce(language, entry) {
	const response = await fetch(`${base}/api/sessions`, {
		method: "POST",
		headers,
		body: JSON.stringify({ language, scaffold: "minimal" }),
	});
	if (!response.ok) return `session request failed (${response.status})`;
	const session = await response.json();
	if (session.language !== language) {
		const why = session.degraded?.[language] ?? "no reason given";
		return `switched off: got a ${session.language} session (${why})`;
	}
	const file = session.files.find((candidate) => candidate.path === entry);
	if (!file) return `the session has no ${entry}`;

	const url = new URL("/ws/runtime", base);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("sessionId", session.sessionId);
	url.searchParams.set("token", session.authToken);
	if (token) url.searchParams.set("t", token);
	const socket = new WebSocket(url, { headers: { origin: base } });
	let values = 0;
	const finished = new Promise((resolve) => {
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.type === "probe_value") values++;
			if (message.type === "run.finished" && message.documentVersion === 2) resolve(message.result);
		});
		socket.addEventListener("close", () => resolve({ reason: "socket closed" }));
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	const send = (message) => socket.send(JSON.stringify({ sessionId: session.sessionId, ...message }));
	send({ type: "settings.update", autoRun: false, autoInspect: true, debounceMs: 150, timeoutMs: 10_000, manualProbeIds: [] });
	send({ type: "document.update", version: 2, path: entry, source: `${file.source}\n` });
	send({ type: "run.request", version: 2, reason: "manual", language });
	const timer = setTimeout(() => socket.close(), RUN_TIMEOUT_MS);
	const result = await finished;
	clearTimeout(timer);
	socket.close();
	if (result.exitCode !== 0) return `run failed: exit ${result.exitCode} ${result.reason ?? ""}`.trim();
	if (values === 0) return "the run reported no probe values";
	return undefined;
}

// All at once: each language runs in its own session.
const problems = await Promise.all(
	Object.entries(LANGUAGES).map(([language, entry]) => runOnce(language, entry).catch(String)),
);
const languages = Object.keys(LANGUAGES);
for (const [index, problem] of problems.entries())
	console.log(`${problem ? "✗" : "✓"} ${languages[index]}${problem ? ` — ${problem}` : ""}`);
process.exitCode = problems.some(Boolean) ? 1 : 0;
