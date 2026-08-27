// Builds the Rust instrumenter when a cargo toolchain is available. Missing
// cargo is not an error: ZigLive simply disables Rust sessions.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const probe = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.warn(
		"[rust-build] cargo not found — Rust sessions will be disabled.",
	);
	process.exit(0);
}
// cargo only discovers .cargo/config.toml (the vendored-sources
// replacement) walking up from the CWD, so run from the crate dir —
// a --manifest-path invocation from the repo root would ask crates.io.
const build = spawnSync(
	"cargo",
	[
	"build",
	"--release",
	"--offline",
	],
	{ stdio: "inherit", cwd: join(import.meta.dirname, "../rust/instrumenter") },
);
process.exit(build.status ?? 1);
