// Serves Atomis to your own tailnet. The listener stays on 127.0.0.1: it is
// tailscaled that accepts the remote connection and proxies it over loopback,
// so nothing on the LAN can reach the port. The only thing the server needs to
// know is the page origin the browser will send, since the Origin guard is the
// server's whole access control (see apps/server-rs/src/util.rs).
import { spawn, spawnSync } from "node:child_process";

const port = Number(process.env.ATOMIS_PORT ?? 4317);

const probe = spawnSync("tailscale", ["status", "--json"], {
	encoding: "utf8",
});
if (probe.error || probe.status !== 0) {
	console.error("[serve-tailscale] tailscale is not running — `tailscale up` first.");
	process.exit(1);
}

const status = JSON.parse(probe.stdout);
const host = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
if (!host) {
	console.error("[serve-tailscale] this machine has no MagicDNS name.");
	process.exit(1);
}

// Without tailnet HTTPS the page would be served over plain http://, which is
// not a secure context: navigator.clipboard is denied, and the editor's
// copy/paste — the only practical one on a tablet — stops working.
if (!status.CertDomains?.length) {
	console.error(
		"[serve-tailscale] HTTPS certificates are off for this tailnet.\n" +
			"  Enable them at https://login.tailscale.com/admin/dns (HTTPS Certificates),\n" +
			"  then run this again. Without them copy/paste breaks in the editor.",
	);
	process.exit(1);
}

const origin = `https://${host}`;
const serve = spawnSync(
	"tailscale",
	["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`],
	{ stdio: "inherit" },
);
if (serve.status !== 0) {
	console.error(
		"[serve-tailscale] `tailscale serve` failed — it needs root unless you have\n" +
			"  run `sudo tailscale set --operator=$USER` once.",
	);
	process.exit(serve.status ?? 1);
}

/** The `cargo run` child, once spawned; signals may arrive before that. */
let server;

let stopped = false;
const stop = () => {
	// Idempotent: reached from the exit handler, from either signal and from
	// the child's own exit — whichever fires first does the work, the rest
	// are no-ops instead of running `tailscale serve … off` twice.
	if (stopped) return;
	stopped = true;
	spawnSync("tailscale", ["serve", "--https=443", "off"], { stdio: "inherit" });
};
// Kill the child before exiting: a bare `process.exit(0)` tore down
// `tailscale serve` and left `cargo run` (and the server under it) orphaned
// on the port. The server also watches for its parent dying, so terminating
// cargo is enough to take both down.
const shutdown = () => {
	if (server && server.exitCode === null) server.kill("SIGTERM");
	stop();
	process.exit(0);
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);

console.log(`[serve-tailscale] ${origin} → 127.0.0.1:${port} (tailnet only)`);

server = spawn(
	"cargo",
	["run", "--release", "--manifest-path", "apps/server-rs/Cargo.toml"],
	{
		stdio: "inherit",
		env: {
			...process.env,
			NODE_ENV: "production",
			ATOMIS_PORT: String(port),
			ATOMIS_ALLOWED_ORIGINS: origin,
		},
	},
);
server.on("exit", (code) => {
	stop();
	process.exit(code ?? 1);
});
