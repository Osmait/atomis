// Builds the desktop sidecar from the RUST server (apps/server-rs): a
// single ~15 MB native binary replaces the previous ~90 MB Node SEA. It
// also stages the runtime resources the server reads from disk
// (instrumenters, session templates, runtimes, web dist). Run before
// `pnpm --filter @atomis/desktop bundle:*`.
import { execFileSync, execSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop/src-tauri");
const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });

// ── 1. release build of the Rust server ──
run("cargo", ["build", "--release", "--manifest-path", join(root, "apps/server-rs/Cargo.toml")]);

const triple = /host: (\S+)/.exec(
	execSync("rustc -vV", { encoding: "utf8" }),
)?.[1];
if (!triple) throw new Error("rustc -vV did not report a host triple");
const binariesDir = join(desktop, "binaries");
mkdirSync(binariesDir, { recursive: true });
const sidecarBin = join(binariesDir, `atomis-server-${triple}`);
copyFileSync(join(root, "apps/server-rs/target/release/atomis-server"), sidecarBin);

// ── 2. runtime resources (paths mirror PROJECT_ROOT layout) ──
const resources = join(desktop, "resources");
rmSync(resources, { recursive: true, force: true });
const entries = [
	"zig-out/bin/runzig-instrument",
	"zig/runtime",
	"zig/session-template",
	"zig/test-runner",
	"rust/runtime",
	"rust/session-template",
	"rust/instrumenter/target/release/rustlive-instrument",
	"go/runtime",
	"go/session-template",
	"go/instrumenter/bin/golive-instrument",
	"ts/instrumenter",
	"ts/runtime",
	"ts/session-template",
	"python/instrumenter",
	"python/runtime",
	"python/test-runner",
	"cfamily/instrumenter",
	"cfamily/runtime",
];
for (const entry of entries) {
	const source = join(root, entry);
	if (!existsSync(source)) {
		console.warn(`⚠ recurso ausente (saltado): ${entry}`);
		continue;
	}
	cpSync(source, join(resources, entry), { recursive: true });
}
cpSync(join(root, "apps/web/dist"), join(resources, "web-dist"), {
	recursive: true,
});

console.log(`sidecar (rust): ${sidecarBin}`);
console.log(`resources: ${resources}`);
