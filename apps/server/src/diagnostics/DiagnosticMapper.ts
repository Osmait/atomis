import type { AppDiagnostic, ProbeDescriptor } from "@ziglive/protocol";

const COMPILER_LOCATION = /^(.*\.zig):(\d+):(\d+): (error|warning|note): (.+)$/;

export function parseCompilerDiagnostics(
	stderr: string,
	generatedPath: string,
): AppDiagnostic[] {
	const diagnostics: AppDiagnostic[] = [];
	for (const line of stderr.split(/\r?\n/)) {
		const match = COMPILER_LOCATION.exec(line);
		if (!match) continue;
		const [, path, lineText, columnText, level, message] = match;
		if (!path || !lineText || !columnText || !level || !message) continue;
		diagnostics.push({
			message: path === generatedPath ? message : `${message} (${path})`,
			severity:
				level === "error"
					? "error"
					: level === "warning"
						? "warning"
						: "information",
			line: Number(lineText),
			column: Number(columnText),
			source: "zig",
		});
	}
	return diagnostics;
}

const EXACT_UNUSED_MESSAGES = new Set([
	"unused local constant",
	"unused local variable",
	"unused function parameter",
]);
const UNUSED_CODES = new Set<string | number>([
	"unused_local",
	"unused-local",
	"unused_local_variable",
]);

interface LspDiagnostic {
	range?: {
		start?: { line?: number; character?: number };
		end?: { line?: number; character?: number };
	};
	message?: string;
	code?: string | number;
}

export function filterObservedUnused(
	diagnostics: LspDiagnostic[],
	probes: ProbeDescriptor[],
): LspDiagnostic[] {
	return diagnostics.filter((diagnostic) => {
		const messageMatches =
			typeof diagnostic.code !== "undefined"
				? UNUSED_CODES.has(diagnostic.code)
				: typeof diagnostic.message === "string" &&
					EXACT_UNUSED_MESSAGES.has(diagnostic.message.trim().toLowerCase());
		if (!messageMatches) return true;
		const start = diagnostic.range?.start;
		if (typeof start?.line !== "number" || typeof start.character !== "number")
			return true;
		const line = start.line;
		const character = start.character;
		return !probes.some(
			(probe) =>
				probe.supported &&
				probe.insertionByte !== undefined &&
				probe.originalRange.startLine - 1 === line &&
				character >= probe.originalRange.startColumn - 1 &&
				character <= probe.originalRange.endColumn - 1,
		);
	});
}
