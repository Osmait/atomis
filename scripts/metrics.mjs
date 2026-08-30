#!/usr/bin/env node
// Code metrics: the shape of the codebase, in numbers that can be compared
// across two commits.
//
//   node scripts/metrics.mjs [--out bench/code-baseline.json]
//
// Lines of code is a weak measure of quality and a decent measure of change:
// what it is good for here is showing whether a refactor actually removed
// work or merely moved it somewhere else.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex === -1 ? "bench/code-latest.json" : args[outIndex + 1];

/** Every file git tracks, which is the only definition of "the code" that
 * cannot drift with someone's node_modules. */
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

const AREAS = [
	["server (rust)", (path) => path.startsWith("apps/server-rs/src/")],
	["web (react)", (path) => path.startsWith("apps/web/src/")],
	["protocol", (path) => path.startsWith("packages/protocol/src/")],
	["instrumenters", (path) => /^(ts|python|go|rust|cfamily|zig)\//.test(path)],
	["e2e", (path) => path.startsWith("tests/")],
	["scripts", (path) => path.startsWith("scripts/")],
];
const CODE = new Set([".rs", ".ts", ".tsx", ".mjs", ".js", ".py", ".go", ".zig", ".c", ".cpp", ".h", ".hpp", ".css"]);

const isTest = (path) => /\.(test|spec)\.[jt]sx?$|_test\.|test_|\.test\./.test(path);

/**
 * Rust keeps its tests inside the file they test, so counting whole files
 * would report a server with no tests at all. Count the `#[cfg(test)]`
 * modules instead, by following their braces.
 */
function rustTestLines(text) {
	const lines = text.split("\n");
	let counted = 0;
	for (let i = 0; i < lines.length; i += 1) {
		if (!/^\s*#\[cfg\(test\)\]/.test(lines[i])) continue;
		let depth = 0;
		let opened = false;
		for (let j = i; j < lines.length; j += 1) {
			for (const character of lines[j]) {
				if (character === "{") {
					depth += 1;
					opened = true;
				} else if (character === "}") depth -= 1;
			}
			counted += 1;
			if (opened && depth === 0) {
				i = j;
				break;
			}
		}
	}
	return counted;
}

const files = [];
for (const path of tracked) {
	if (!CODE.has(extname(path))) continue;
	if (path.includes("/vendor/") || path.includes("/generated/")) continue;
	let text;
	try {
		text = readFileSync(join(root, path), "utf8");
	} catch {
		// A file still in the index but gone from disk.
		continue;
	}
	const lines = text.split("\n").length;
	const inlineTestLines = path.endsWith(".rs") ? rustTestLines(text) : 0;
	files.push({ path, lines, inlineTestLines, test: isTest(path) });
}

const sum = (list) => list.reduce((total, file) => total + file.lines, 0);
const areas = {};
for (const [name, matches] of AREAS) {
	const mine = files.filter((file) => matches(file.path));
	const production = mine.filter((file) => !file.test);
	const tests = mine.filter((file) => file.test);
	const inline = mine.reduce((total, file) => total + file.inlineTestLines, 0);
	areas[name] = {
		files: mine.length,
		lines: sum(mine),
		productionLines: sum(production) - inline,
		testLines: sum(tests) + inline,
	};
}

const production = files.filter((file) => !file.test);
const inlineTests = files.reduce((total, file) => total + file.inlineTestLines, 0);
const report = {
	takenAt: new Date().toISOString(),
	commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
	totals: {
		files: files.length,
		lines: sum(files),
		productionLines: sum(production) - inlineTests,
		testLines: sum(files.filter((file) => file.test)) + inlineTests,
		// Files big enough that nobody holds them in their head at once.
		filesOver500Lines: production.filter((file) => file.lines > 500).length,
	},
	areas,
	// The ten worth looking at first, whatever the reason.
	largest: production
		.toSorted((a, b) => b.lines - a.lines)
		.slice(0, 10)
		.map((file) => ({ path: file.path, lines: file.lines })),
};

// An absolute --out means exactly where it says, not under the repo.
const outPath = isAbsolute(OUT) ? OUT : join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
