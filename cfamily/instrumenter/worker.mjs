// clive-instrument as a long-lived process, one per session.
//
// Unlike the TS and Python workers this one is not shared: instrumenting C
// runs clang on the session's file, and clang follows its #include lines, so
// it must stay inside the session's sandbox. The server starts one per
// session under that sandbox (Landlock is inherited by clang) and stops it
// with the session. What it saves is starting node and loading this module
// on every run; clang's own AST dump still runs per file.
//
// Request:  {"id", "inputPath", "lang", "uri", "version", "fileId",
//            "autoInspect", "manual", "output", "sourceMap"}
// Answer:   {"id", "json", "generated"} or {"id", "error"}. The server
//           writes the files; `json` is exactly what the CLI prints.
import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { instrument, render } from "./clive-instrument.mjs";

const MAX_SOURCE_BYTES = 1024 * 1024;

for await (const line of createInterface({ input: process.stdin })) {
	let id = null;
	try {
		const request = JSON.parse(line);
		id = request.id;
		if (statSync(request.inputPath).size > MAX_SOURCE_BYTES)
			throw new Error(`${request.inputPath} exceeds 1 MiB`);
		const result = instrument(readFileSync(request.inputPath, "utf8"), {
			inputPath: request.inputPath,
			inputName: request.inputPath.split("/").at(-1) ?? request.inputPath,
			uri: request.uri,
			lang: request.lang === "cpp" ? "cpp" : "c",
			autoInspect: request.autoInspect,
			manualIds: request.manual,
			fileId: request.fileId,
		});
		const json = render(result, request.output, request.sourceMap, request.version);
		process.stdout.write(`${JSON.stringify({ id, json, generated: result.generated })}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ id, error: String(error?.stack ?? error) })}\n`);
	}
}
