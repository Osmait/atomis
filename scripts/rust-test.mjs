// Runs the Rust instrumenter unit tests when cargo is available.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const probe = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.warn("[rust-test] cargo not found — skipping Rust unit tests.");
	process.exit(0);
}
// cargo only discovers .cargo/config.toml (the vendored-sources
// replacement) walking up from the CWD, so run from the crate dir —
// a --manifest-path invocation from the repo root would ask crates.io.
const test = spawnSync(
	"cargo",
	[
	"test",
	"--release",
	"--offline",
	],
	{ stdio: "inherit", cwd: join(import.meta.dirname, "../rust/instrumenter") },
);
process.exit(test.status ?? 1);
