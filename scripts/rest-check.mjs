#!/usr/bin/env node
// Checks a REST demo against the todo-list contract every version of it
// keeps, by running it in a live Atomis as a server and calling it through
// the session proxy.
//
//   node scripts/rest-check.mjs <base-url> <demo-dir> <language> [dep,dep…]
//
// Exits non-zero naming the first steps that differ. The same contract is
// in tests/e2e/demos.spec.ts; this is the quick loop while writing one.

/* eslint-disable no-await-in-loop -- The contract's steps build on each
   other (create, then read what was created), so they go one at a time. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY = { zig: "main.zig", rust: "main.rs", go: "main.go", ts: "main.ts", py: "main.py", c: "main.c", cpp: "main.cpp" };

/** [method, path, body or null, status, expected JSON] — "" is an empty
 * body, null is not compared. Shared with tests/e2e/demos.spec.ts. */
export const CONTRACT = JSON.parse(
	readFileSync(new URL("../demos/rest/contract.json", import.meta.url), "utf8"),
).steps;

/** JSON with object keys in order: languages disagree on key order. */
const canonical = (value) =>
	JSON.stringify(value, (_, inner) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
			: inner,
	);

const [base, dir, language, deps] = process.argv.slice(2);
if (!base || !dir || !ENTRY[language]) {
	console.error("usage: node scripts/rest-check.mjs <base-url> <demo-dir> <language> [dep,dep…]");
	process.exit(2);
}
const entry = ENTRY[language];
const headers = { origin: base, "content-type": "application/json" };
const dependencies = deps ? deps.split(",") : [];
const created = await fetch(`${base}/api/sessions`, {
	method: "POST",
	headers,
	body: JSON.stringify({
		language,
		files: [{ path: entry, source: readFileSync(join(dir, entry), "utf8") }],
		...(dependencies.length ? { dependencies } : {}),
	}),
});
if (!created.ok) {
	console.error(`session: ${created.status} ${await created.text()}`);
	process.exit(1);
}
const session = await created.json();
if (session.language !== language) {
	console.error(`${language} is switched off here: got a ${session.language} session`);
	process.exit(1);
}

const url = new URL("/ws/runtime", base);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("sessionId", session.sessionId);
url.searchParams.set("token", session.authToken);
const socket = new WebSocket(url, { headers: { origin: base } });
const log = [];
socket.addEventListener("message", (event) => {
	const message = JSON.parse(String(event.data));
	if (message.type === "output") log.push(message.chunk);
	if (message.type === "diagnostics") for (const item of message.diagnostics ?? []) log.push(`[diag] ${item.path ?? ""}:${item.line} ${item.message}\n`);
	if (message.type === "deps.state") log.push(`[deps] ${message.state} ${message.name ?? ""} ${message.error ?? ""}\n`);
	if (message.type === "deps.output") log.push(message.chunk);
	if (message.type === "server.error") log.push(`[error] ${message.message}\n`);
});
await new Promise((resolve) => {
	socket.addEventListener("open", resolve, { once: true });
});
socket.send(
	JSON.stringify({
		type: "settings.update",
		sessionId: session.sessionId,
		autoRun: true,
		autoInspect: true,
		debounceMs: 150,
		timeoutMs: 2000,
		manualProbeIds: [],
		serve: true,
	}),
);

const call = async (method, path, body) => {
	const response = await fetch(`${base}/api/sessions/${session.sessionId}/http${path}`, {
		method,
		headers: { origin: base, "x-atomis-session": session.authToken, ...(body ? { "content-type": "application/json" } : {}) },
		...(body ? { body } : {}),
	});
	return { status: response.status, text: await response.text(), proxy: response.headers.has("x-atomis-proxy-error"), type: response.headers.get("content-type") };
};

// Installs and a first compile can take minutes (a framework, a cold cache).
const deadline = Date.now() + (dependencies.length ? 600_000 : 180_000);
let up = false;
while (Date.now() < deadline) {
	const probe = await call("GET", "/health").catch(() => ({ proxy: true }));
	if (!probe.proxy) {
		up = true;
		break;
	}
	await new Promise((resolve) => {
		setTimeout(resolve, 1000);
	});
}
if (!up) {
	console.error("the server never answered /health. Program output:\n" + log.join("").slice(-4000));
	socket.close();
	process.exit(1);
}

let failures = 0;
for (const [method, path, body, status, expected] of CONTRACT) {
	const got = await call(method, path, body);
	let problem = got.status === status ? "" : `status ${got.status}, expected ${status}`;
	if (!problem && expected === "" && got.text !== "") problem = `expected an empty body, got ${JSON.stringify(got.text)}`;
	if (!problem && expected !== null && expected !== "") {
		let parsed;
		try {
			parsed = JSON.parse(got.text);
		} catch {
			problem = `body is not JSON: ${JSON.stringify(got.text.slice(0, 200))}`;
		}
		if (!problem && canonical(parsed) !== canonical(expected))
			problem = `body ${JSON.stringify(parsed)}, expected ${JSON.stringify(expected)}`;
		if (!problem && !got.type?.includes("json")) problem = `content-type ${got.type}, expected JSON`;
	}
	if (problem) failures++;
	console.log(`${problem ? "✗" : "✓"} ${method} ${path}${body ? ` ${body}` : ""}${problem ? ` — ${problem}` : ""}`);
}
socket.close();
if (failures) console.log("Program output (tail):\n" + log.join("").slice(-2000));
process.exit(failures ? 1 : 0);
