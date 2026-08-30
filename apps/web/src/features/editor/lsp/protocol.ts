/**
 * Pure LSP wire helpers: coordinate conversion between LSP (0-based) and
 * Monaco (1-based), payload normalization, and canned answers for the
 * server→client requests Atomis supports. `LspClient` stays in charge of
 * sockets, providers and Monaco objects.
 */
/** What can actually travel over the JSON-RPC socket. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * Assert a wire value into the shape a handler expects. The intermediate
 * `object` step keeps the assertion legal from the `JsonValue` union without
 * reaching for `unknown`/`any`.
 */
export function asShape<T>(value: JsonValue | null | undefined): T {
	return value as object as T;
}

export interface RpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: JsonValue;
	result?: JsonValue;
	error?: { code?: number; message?: string };
}

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface LspDiagnostic {
	range: LspRange;
	message: string;
	severity?: number;
	code?: string | number;
	source?: string;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export function toMonacoPosition(position: LspPosition): {
	lineNumber: number;
	column: number;
} {
	return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function toMonacoRange(range: LspRange): {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
} {
	return {
		startLineNumber: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLineNumber: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

export function fromMonacoBounds(
	startLineNumber: number,
	startColumn: number,
	endLineNumber: number,
	endColumn: number,
): LspRange {
	return {
		start: { line: startLineNumber - 1, character: startColumn - 1 },
		end: { line: endLineNumber - 1, character: endColumn - 1 },
	};
}

/** LSP DiagnosticSeverity (1–4) → the protocol's severity name. */
export function lspSeverityName(
	severity?: number,
): "error" | "warning" | "information" | "hint" {
	return severity === 2
		? "warning"
		: severity === 3
			? "information"
			: severity === 4
				? "hint"
				: "error";
}

/** Hover contents in any LSP shape → Monaco markdown strings. */
export function normalizeHoverContents(
	contents: JsonValue | undefined,
): { value: string }[] {
	const raw = Array.isArray(contents) ? contents : [contents];
	return raw.filter(Boolean).map((entry) => {
		if (typeof entry === "string") return { value: entry };
		const value = asShape<{ value?: string; language?: string }>(entry);
		return {
			value: value.language
				? `\`\`\`${value.language}\n${value.value ?? ""}\n\`\`\``
				: (value.value ?? ""),
		};
	});
}

/** Completion insert text: textEdit wins, then insertText, then the label. */
export function completionInsertText(item: {
	label: string;
	insertText?: string;
	textEdit?: LspTextEdit;
}): string {
	return item.textEdit?.newText ?? item.insertText ?? item.label;
}

/**
 * Result for a server→client request. `workspace/configuration` gets one
 * empty section per requested item; edits are refused; anything else nulls.
 */
export function answerServerRequest(
	method: string | undefined,
	params: JsonValue | undefined,
): JsonValue {
	if (method === "workspace/configuration")
		return (asShape<{ items?: JsonValue[] }>(params)?.items ?? []).map(
			() => ({}),
		);
	if (method === "workspace/applyEdit")
		return {
			applied: false,
			failureReason: "Server initiated edits are not supported",
		};
	return null;
}
