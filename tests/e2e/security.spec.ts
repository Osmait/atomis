import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The HTTP guards, exercised over the wire against a server of this spec's
 * own — no browser, no shared webServer. A browser can never send these
 * requests (it either attaches the right Origin/Host or refuses to), which
 * is exactly why nothing else covers them: they are what a curl, a rebound
 * DNS name or a foreign page would send.
 *
 * The server starts on an ephemeral port (ATOMIS_PORT=0, announced via the
 * ATOMIS_LISTENING line) with a token and isolated stores, and is killed in
 * the finally — it never touches 4317 or the e2e stack.
 */

// Playwright transpiles specs to CJS, where import.meta does not exist;
// workers run with the config's directory as cwd, which is the repo root.
const root = resolve(process.cwd());

function serverBinary(): string {
	const release = join(root, "apps/server-rs/target/release/atomis-server");
	const debug = join(root, "apps/server-rs/target/debug/atomis-server");
	// Build first, use the binary second: a pre-existing release binary can
	// predate the very guards under test (it did — an old one accepted a
	// rebound Host), and an incremental `cargo build` is near-instant when
	// nothing changed. Machines without cargo fall back to whichever binary
	// is newest.
	const built = spawnSync(
		"cargo",
		["build", "--manifest-path", join(root, "apps/server-rs/Cargo.toml")],
		{ stdio: "inherit" },
	);
	if (built.status === 0 && existsSync(debug)) return debug;
	const newest = [release, debug]
		.filter((path) => existsSync(path))
		.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
		.at(0);
	if (!newest)
		throw new Error("no atomis-server binary and `cargo build` failed");
	return newest;
}

test("token, Origin and Host guards refuse what a browser could not send", async ({
	request,
}) => {
	// Server startup plus a doctor run (it probes every toolchain) can be
	// slow on a cold machine.
	test.slow();
	const token = "secreto-e2e-spec";
	const dataDir = mkdtempSync(join(tmpdir(), "atomis-e2e-security-"));
	const server = spawn(serverBinary(), {
		cwd: root,
		env: {
			...process.env,
			ATOMIS_TOKEN: token,
			ATOMIS_PREFERENCES: join(dataDir, "preferences.json"),
			ATOMIS_WORKSPACES: join(dataDir, "workspaces"),
			// Port 0: the OS picks a free one and the server announces it,
			// so this can never collide with the real 4317 or the e2e stack.
			ATOMIS_PORT: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	server.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	try {
		const port = await new Promise<number>((resolvePort, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(`server never announced a port. stderr:\n${stderr}`),
					),
				30_000,
			);
			let buffer = "";
			server.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const match = buffer.match(/ATOMIS_LISTENING=(\d+)/);
				if (match) {
					clearTimeout(timer);
					resolvePort(Number(match[1]));
				}
			});
			server.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`server exited early (${code}). stderr:\n${stderr}`));
			});
		});
		const base = `http://127.0.0.1:${port}`;
		const bearer = { authorization: `Bearer ${token}` };

		// No token: the inventory of toolchains is refused outright.
		const anonymous = await request.get(`${base}/api/doctor`);
		expect(anonymous.status()).toBe(403);

		// The right token with the server's own Host: allowed.
		const doctored = await request.get(`${base}/api/doctor`, {
			headers: bearer,
		});
		expect(doctored.status()).toBe(200);
		expect(
			((await doctored.json()) as { checks: { name: string }[] }).checks
				.length,
		).toBeGreaterThan(0);

		// A foreign page: even with the token, a mutation carrying another
		// site's Origin is refused — the CSRF wall.
		const crossSite = await request.post(`${base}/api/sessions`, {
			headers: { ...bearer, origin: "http://evil.example" },
			data: { language: "zig", scaffold: "minimal" },
		});
		expect(crossSite.status()).toBe(403);

		// DNS rebinding: evil.com resolves to 127.0.0.1, the page becomes
		// same-origin in the browser's eyes and its GETs carry no Origin —
		// but Host still says evil.com, and that is refused.
		const rebound = await request.get(`${base}/api/preferences`, {
			headers: { ...bearer, host: `evil.com:${port}` },
		});
		expect(rebound.status()).toBe(403);

		// The same read with an honest Host: allowed.
		const legitimate = await request.get(`${base}/api/preferences`, {
			headers: bearer,
		});
		expect(legitimate.status()).toBe(200);
	} finally {
		if (server.exitCode === null) {
			const exited = new Promise<void>((resolveExit) => {
				server.once("exit", () => resolveExit());
			});
			server.kill("SIGTERM");
			// The server drains politely for up to ~3s; give it that, then
			// stop waiting — SIGKILL as the backstop so nothing leaks.
			await Promise.race([
				exited,
				new Promise<void>((resolveWait) => {
					setTimeout(() => {
						server.kill("SIGKILL");
						resolveWait();
					}, 5_000);
				}),
			]);
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
});
