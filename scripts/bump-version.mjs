// Bumps every version manifest in the repo in lockstep. Usage:
//   node scripts/bump-version.mjs patch|minor|major|X.Y.Z
// Prints the new version on stdout (last line) for CI consumption.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const request = process.argv[2];
if (!request) {
	console.error("usage: node scripts/bump-version.mjs patch|minor|major|X.Y.Z");
	process.exit(1);
}

const rootPackage = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
);
const current = rootPackage.version;
const explicit = /^\d+\.\d+\.\d+$/.test(request);
let next;
if (explicit) next = request;
else {
	const [major, minor, patch] = current.split(".").map(Number);
	if (request === "major") next = `${major + 1}.0.0`;
	else if (request === "minor") next = `${major}.${minor + 1}.0`;
	else if (request === "patch") next = `${major}.${minor}.${patch + 1}`;
	else {
		console.error(`unknown bump: ${request}`);
		process.exit(1);
	}
}

const packageJsons = [
	"package.json",
	"apps/web/package.json",
	"apps/desktop/package.json",
	"packages/protocol/package.json",
];
for (const file of packageJsons) {
	const path = join(root, file);
	const pkg = JSON.parse(readFileSync(path, "utf8"));
	pkg.version = next;
	writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

const tauriConf = join(root, "apps/desktop/src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(tauriConf, "utf8"));
conf.version = next;
writeFileSync(tauriConf, `${JSON.stringify(conf, null, 2)}\n`);

// Cargo manifests: first `version = "…"` line of each [package] section,
// plus the matching package entry in each Cargo.lock so builds stay clean.
const cargoPackages = [
	{ toml: "apps/server-rs/Cargo.toml", lock: "apps/server-rs/Cargo.lock", name: "atomis-server" },
	{ toml: "apps/desktop/src-tauri/Cargo.toml", lock: "apps/desktop/src-tauri/Cargo.lock", name: "app" },
];
for (const { toml, lock, name } of cargoPackages) {
	const tomlPath = join(root, toml);
	const source = readFileSync(tomlPath, "utf8");
	const bumped = source.replace(
		/^version = "\d+\.\d+\.\d+"$/m,
		`version = "${next}"`,
	);
	if (bumped === source) {
		console.error(`no version line in ${toml}`);
		process.exit(1);
	}
	writeFileSync(tomlPath, bumped);
	const lockPath = join(root, lock);
	const lockSource = readFileSync(lockPath, "utf8");
	const lockBumped = lockSource.replace(
		new RegExp(`(name = "${name}"\\nversion = )"\\d+\\.\\d+\\.\\d+"`),
		`$1"${next}"`,
	);
	writeFileSync(lockPath, lockBumped);
}

console.error(`version: ${current} → ${next}`);
console.log(next);
