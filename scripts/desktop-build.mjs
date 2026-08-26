// Builds the desktop sidecar: bundles the Node server into a single-executable
// (Node SEA), and assembles the runtime resources the server reads from disk
// (instrumenters, session templates, runtimes, web dist). Run before
// `pnpm --filter @ziglive/desktop bundle:*`.
import { execFileSync, execSync } from "node:child_process";
import {
	cpSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop/src-tauri");
const stage = join(desktop, "sidecar-build");
const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });

// ── 1. bundle the server to a single CJS file ──
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
run("pnpm", [
	"exec",
	"esbuild",
	join(root, "apps/server/src/index.ts"),
	"--bundle",
	"--platform=node",
	"--format=cjs",
	"--target=node22",
	`--outfile=${join(stage, "server.cjs")}`,
	"--log-override:empty-import-meta=silent",
], { cwd: join(root, "apps/desktop") });

// ── 2. Node SEA: inject the bundle into a copy of the node binary ──
writeFileSync(
	join(stage, "sea-config.json"),
	JSON.stringify({
		main: join(stage, "server.cjs"),
		output: join(stage, "sea-prep.blob"),
		disableExperimentalSEAWarning: true,
	}),
);
run(process.execPath, ["--experimental-sea-config", join(stage, "sea-config.json")]);

const triple = /host: (\S+)/.exec(
	execSync("rustc -vV", { encoding: "utf8" }),
)?.[1];
if (!triple) throw new Error("rustc -vV did not report a host triple");
const binariesDir = join(desktop, "binaries");
mkdirSync(binariesDir, { recursive: true });
const sidecarBin = join(binariesDir, `ziglive-server-${triple}`);
copyFileSync(process.execPath, sidecarBin);
// macOS: the node binary ships signed; postject requires stripping the
// signature first and an ad-hoc re-sign afterwards.
if (process.platform === "darwin")
	run("codesign", ["--remove-signature", sidecarBin]);
run("pnpm", [
	"exec",
	"postject",
	sidecarBin,
	"NODE_SEA_BLOB",
	join(stage, "sea-prep.blob"),
	"--sentinel-fuse",
	"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
	...(process.platform === "darwin"
		? ["--macho-segment-name", "NODE_SEA"]
		: []),
], { cwd: join(root, "apps/desktop") });
if (process.platform === "darwin") run("codesign", ["--sign", "-", sidecarBin]);

// ── 3. runtime resources (paths mirror PROJECT_ROOT layout) ──
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

console.log(`sidecar: ${sidecarBin}`);
console.log(`resources: ${resources}`);
