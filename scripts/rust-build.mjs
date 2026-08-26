// Builds the Rust instrumenter when a cargo toolchain is available. Missing
// cargo is not an error: ZigLive simply disables Rust sessions.
import { spawnSync } from "node:child_process";

const probe = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.warn(
		"[rust-build] cargo not found — Rust sessions will be disabled.",
	);
	process.exit(0);
}
const build = spawnSync(
	"cargo",
	[
		"build",
		"--release",
		"--offline",
		"--manifest-path",
		"rust/instrumenter/Cargo.toml",
	],
	{ stdio: "inherit" },
);
process.exit(build.status ?? 1);
