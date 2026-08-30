#!/usr/bin/env node
// Compresses the built UI once, at build time.
//
// The alternative is compressing on every request, which costs a brotli
// encoder per response in flight: measured at 86MB of resident memory for
// twelve concurrent downloads of the editor chunk, against 7MB idle. These
// files never change — their names carry a content hash — so compressing
// them once is both cheaper and better: this uses brotli's maximum quality,
// which no server would spend on a live request.
//
// The server serves the `.br`/`.gz` sibling when the client accepts it.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const dist = join(root, "apps/web/dist");
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".json", ".svg", ".map", ".txt"]);
// Below this, the header overhead is most of the file and the win is noise.
const MIN_BYTES = 1024;

let files = 0;
let before = 0;
let brotli = 0;

function walk(directory) {
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			walk(path);
			continue;
		}
		if (name.endsWith(".br") || name.endsWith(".gz")) continue;
		if (!COMPRESSIBLE.has(extname(name))) continue;
		const bytes = readFileSync(path);
		if (bytes.length < MIN_BYTES) continue;
		writeFileSync(
			`${path}.br`,
			brotliCompressSync(bytes, {
				params: {
					[constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
					[constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
				},
			}),
		);
		// gzip as well: a client that speaks neither is rare, one that speaks
		// only gzip is not.
		writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
		files += 1;
		before += bytes.length;
		brotli += statSync(`${path}.br`).size;
	}
}

walk(dist);
const kb = (bytes) => Math.round(bytes / 1024);
console.log(
	`precomprimidos ${files} archivos: ${kb(before)} KB → ${kb(brotli)} KB brotli`,
);
