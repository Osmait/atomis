// Runs the Go instrumenter unit tests when go is available.
import { spawnSync } from "node:child_process";

const probe = spawnSync("go", ["version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.warn("[go-test] go not found — skipping Go unit tests.");
	process.exit(0);
}
const test = spawnSync("go", ["test", "./..."], {
	cwd: "go/instrumenter",
	stdio: "inherit",
	env: { ...process.env, GOPROXY: "off", GOFLAGS: "-mod=mod" },
});
process.exit(test.status ?? 1);
