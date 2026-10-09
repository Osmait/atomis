#!/usr/bin/env node
// Turns load-test results into one self-contained page: what was measured,
// and what it would cost to host for a month under a usage you dial in.
//
//   node scripts/load-report.mjs [--unbounded bench/load-unbounded.json]
//       [--sized bench/load-2cpu-2g.json] [--before bench/baseline-load]
//       [--out bench/load-report.html]
//
// The page carries its data inline, so it opens from disk and can be
// published as-is. --before names a directory holding an earlier pair of
// results under the same file names; the page then shows both.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
};
const resolve = (path) => (isAbsolute(path) ? path : join(root, path));
const load = (path) => (path ? JSON.parse(readFileSync(resolve(path), "utf8")) : null);

const unbounded = load(flag("--unbounded", "bench/load-unbounded.json"));
const sized = load(flag("--sized", "bench/load-2cpu-2g.json"));
const beforeDir = flag("--before", "");
const before = beforeDir
	? { unbounded: load(join(beforeDir, "load-unbounded.json")), sized: load(join(beforeDir, "load-2cpu-2g.json")) }
	: null;
// First-visit transfer comes from the browser benchmark, when there is one.
let firstLoadKb = 954;
try {
	firstLoadKb = load("bench/after.json").firstLoad.transferredKb ?? firstLoadKb;
} catch {
	/* no browser benchmark: keep the default */
}
const OUT = resolve(flag("--out", "bench/load-report.html"));

const data = { unbounded, sized, before, firstLoadKb };
const template = readFileSync(join(import.meta.dirname, "load-report.template.html"), "utf8");
// `</` inside a JSON string would close the script element early.
const json = JSON.stringify(data).replaceAll("</", "<\\/");
writeFileSync(OUT, template.replace("/*__DATA__*/null", json));
console.log(`wrote ${OUT}`);
