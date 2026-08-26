// ZigLive session runtime for TypeScript/JavaScript. Loaded via `node
// --import` so the globals exist before ANY user module executes; probe
// values flow as NDJSON on fd 3 and log markers on the stream that the
// original console call writes to.
import { writeSync } from "node:fs";
import { inspect } from "node:util";

const MAX_PREVIEW = 512;
const MARKER_START = "\u001e";
const MARKER_END = "\u001f";
let sequence = 0;

function writeFd(fd, text) {
	try {
		writeSync(fd, text);
	} catch {
		// fd 3 absent outside the supervisor; ignore
	}
}

function truncate(preview) {
	if (preview.length <= MAX_PREVIEW) return { preview, truncated: false };
	return { preview: `${preview.slice(0, MAX_PREVIEW)}…`, truncated: true };
}

function renderPreview(value) {
	try {
		return inspect(value, {
			depth: 3,
			maxArrayLength: 20,
			maxStringLength: 256,
			breakLength: Infinity,
			compact: true,
		});
	} catch {
		return "<preview unavailable>";
	}
}

function typeName(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "Array";
	const kind = typeof value;
	if (kind === "object" || kind === "function")
		return value.constructor?.name ?? kind;
	return kind;
}

globalThis.__ziglive_probe = (probeId, line, column, name, value) => {
	const { preview, truncated } = truncate(renderPreview(value));
	const record = {
		protocolVersion: 1,
		kind: "probe_value",
		probeId,
		name,
		line,
		column,
		typeName: typeName(value),
		preview,
		truncated,
		sequence: sequence++,
	};
	writeFd(3, `${JSON.stringify(record)}\n`);
};

globalThis.__ziglive_log = (fd, fileId, line, column) => {
	writeFd(fd, `${MARKER_START}ZIGLIVE_LOG:${fileId}:${line}:${column}${MARKER_END}`);
};

globalThis.__ziglive_log_loop = (
	fd,
	fileId,
	line,
	column,
	loopLine,
	loopColumn,
	variable,
	value,
) => {
	const { preview } = truncate(renderPreview(value));
	writeFd(
		fd,
		`${MARKER_START}ZIGLIVE_LOG:${fileId}:${line}:${column}:${loopLine}:${loopColumn}:${variable}:${preview}${MARKER_END}`,
	);
};
