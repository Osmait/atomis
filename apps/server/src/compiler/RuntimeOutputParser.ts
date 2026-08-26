export interface LogSourceLocation {
	path?: string;
	line: number;
	column: number;
	executionIndex: number;
	loop?: {
		line: number;
		column: number;
		variable: string;
		value: string;
	};
}

export type OutputEmitter = (
	stream: "stdout" | "stderr",
	chunk: string,
	category: "program" | "error",
	sourceLocation?: LogSourceLocation,
) => void;

export interface MarkerParser {
	push(chunk: string): void;
	flush(): void;
}

const LOG_MARKER =
	// eslint-disable-next-line no-control-regex
	/\x1eZIGLIVE_LOG:(\d+):(\d+):(\d+)(?::(\d+):(\d+):([A-Za-z_][A-Za-z0-9_]*):([\s\S]*?))?\x1f/;
const PANIC_PATTERN =
	/(?:^|\s)(?:thread \d+ )?panic:|panicked at|Traceback \(most recent call last\)|Assertion .*failed/i;

/**
 * Streams one OS pipe, strips `\x1eZIGLIVE_LOG:…\x1f` source markers emitted
 * by the instrumented runtimes, and forwards the surrounding text annotated
 * with the marker's source location. A marker always FOLLOWS the output of
 * the log statement that produced it, so buffered text before a marker gets
 * that marker's location. `detectErrors` turns on the stderr panic/error
 * heuristics; stdout output is always reported as `program`.
 */
export function createMarkerParser(options: {
	stream: "stdout" | "stderr";
	detectErrors: boolean;
	fileIds: Map<number, string>;
	emit: OutputEmitter;
}): MarkerParser {
	let buffer = "";
	let stickyError = false;
	const logCounts = new Map<string, number>();

	const emitText = (text: string, sourceLocation?: LogSourceLocation): void => {
		for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
			if (options.detectErrors && PANIC_PATTERN.test(line)) stickyError = true;
			const lineIsError =
				options.detectErrors &&
				(stickyError || /(?:^|\s)error:/i.test(line));
			options.emit(
				options.stream,
				line,
				lineIsError ? "error" : "program",
				stickyError ? undefined : sourceLocation,
			);
		}
	};

	return {
		push(chunk: string): void {
			buffer += chunk;
			let marker = LOG_MARKER.exec(buffer);
			while (marker?.[1] && marker[2] && marker[3]) {
				const path = options.fileIds.get(Number(marker[1]));
				const line = Number(marker[2]);
				const column = Number(marker[3]);
				const countKey = `${path ?? "unknown"}:${line}:${column}`;
				const executionIndex = (logCounts.get(countKey) ?? 0) + 1;
				logCounts.set(countKey, executionIndex);
				const sourceLocation: LogSourceLocation = {
					...(path ? { path } : {}),
					line,
					column,
					executionIndex,
					...(marker[4] && marker[5] && marker[6] && marker[7] !== undefined
						? {
								loop: {
									line: Number(marker[4]),
									column: Number(marker[5]),
									variable: marker[6],
									value: marker[7],
								},
							}
						: {}),
				};
				emitText(buffer.slice(0, marker.index), sourceLocation);
				buffer = buffer.slice(marker.index + marker[0].length);
				marker = LOG_MARKER.exec(buffer);
			}
		},
		flush(): void {
			emitText(buffer);
			buffer = "";
		},
	};
}
