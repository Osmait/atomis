// The instrumenter as a long-lived process: the server sends one request per
// line on stdin and reads one answer per line on stdout.
//
// Loading the TypeScript parser is most of what instrumenting costs — about
// 110 ms of a run, even with V8's compile cache, against a few ms of actual
// transform — and the one-process-per-file CLI paid it on every keystroke.
// This process pays it once.
//
// It never touches the filesystem: the server reads the source, sends its
// text, and writes the generated file and source map itself from the answer.
// `instrument` keeps no state between calls, so one session's request cannot
// influence another's — which is what makes sharing one process safe.
//
// Request:  {"id", "source", "uri", "version", "fileId", "autoInspect",
//            "manual", "output", "sourceMap"}
// Answer:   {"id", "json", "generated"} — `json` exactly what the CLI prints
//           on stdout, `generated` null when the source did not parse — or
//           {"id", "error"}.
import { createInterface } from "node:readline";
import { instrument, render } from "./instrument.mjs";

for await (const line of createInterface({ input: process.stdin })) {
	let id = null;
	try {
		const request = JSON.parse(line);
		id = request.id;
		const result = instrument(
			request.source,
			request.uri,
			request.autoInspect,
			request.manual,
			request.fileId,
		);
		const json = render(result, request.output, request.sourceMap, request.version);
		process.stdout.write(
			`${JSON.stringify({ id, json, generated: result.generated ?? null })}\n`,
		);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ id, error: String(error?.stack ?? error) })}\n`,
		);
	}
}
