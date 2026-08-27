// Builds the Go instrumenter when a Go toolchain is available. Missing go is
// not an error: Atomis simply disables Go sessions.
import { spawnSync } from "node:child_process";

const probe = spawnSync("go", ["version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
	console.warn("[go-build] go not found — Go sessions will be disabled.");
	process.exit(0);
}
const build = spawnSync(
	"go",
	["build", "-o", "bin/golive-instrument", "."],
	{ cwd: "go/instrumenter", stdio: "inherit", env: { ...process.env, GOPROXY: "off", GOFLAGS: "-mod=mod" } },
);
process.exit(build.status ?? 1);
