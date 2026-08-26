// Runs the Rust instrumenter unit tests when cargo is available.
import { spawnSync } from "node:child_process";

const probe = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.warn("[rust-test] cargo not found — skipping Rust unit tests.");
	process.exit(0);
}
const test = spawnSync(
	"cargo",
	[
		"test",
		"--release",
		"--offline",
		"--manifest-path",
		"rust/instrumenter/Cargo.toml",
	],
	{ stdio: "inherit" },
);
process.exit(test.status ?? 1);
