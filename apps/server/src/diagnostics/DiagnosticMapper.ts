import type { AppDiagnostic, ProbeDescriptor } from "@ziglive/protocol";

const COMPILER_LOCATION = /^(.*\.zig):(\d+):(\d+): (error|warning|note): (.+)$/;

function generatedPathAliases(generatedPath: string): string[] {
	const normalized = generatedPath.replaceAll("\\", "/");
	const relative = normalized.split("/").slice(-2).join("/");
	return relative === normalized ? [normalized] : [normalized, relative];
}

function isGeneratedPath(path: string, generatedPath: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return generatedPathAliases(generatedPath).includes(normalized);
}

function generatedReference(
	line: string,
	generatedPath: string,
): { line: number; column: number } | undefined {
	for (const alias of generatedPathAliases(generatedPath)) {
		const marker = `${alias}:`;
		const markerIndex = line.indexOf(marker);
		if (markerIndex < 0) continue;
		const location = /^(\d+):(\d+)(?:\s|$)/.exec(
			line.slice(markerIndex + marker.length),
		);
		if (!location?.[1] || !location[2]) continue;
		return { line: Number(location[1]), column: Number(location[2]) };
	}
	return undefined;
}

function findGeneratedReference(
	lines: string[],
	startIndex: number,
	generatedPath: string,
): { line: number; column: number } | undefined {
	for (let index = startIndex; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined) return undefined;
		const reference = generatedReference(line, generatedPath);
		if (reference) return reference;
		const diagnostic = COMPILER_LOCATION.exec(line);
		if (diagnostic?.[4] === "error" || diagnostic?.[4] === "warning")
			return undefined;
	}
	return undefined;
}

function compilerSeverity(level: string): AppDiagnostic["severity"] {
	if (level === "error") return "error";
	if (level === "warning") return "warning";
	return "information";
}

export function parseCompilerDiagnostics(
	stderr: string,
	generatedPath: string,
): AppDiagnostic[] {
	const diagnostics: AppDiagnostic[] = [];
	const lines = stderr.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		const match = COMPILER_LOCATION.exec(line);
		if (!match) continue;
		const [, path, lineText, columnText, level, message] = match;
		if (!path || !lineText || !columnText || !level || !message) continue;
		const generated = isGeneratedPath(path, generatedPath);
		const reference = generated
			? undefined
			: findGeneratedReference(lines, index + 1, generatedPath);
		diagnostics.push({
			message: generated ? message : `${message} (${path})`,
			severity: compilerSeverity(level),
			line: reference?.line ?? Number(lineText),
			column: reference?.column ?? Number(columnText),
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
		let messageMatches = false;
		if (diagnostic.code !== undefined)
			messageMatches = UNUSED_CODES.has(diagnostic.code);
		else if (typeof diagnostic.message === "string")
			messageMatches = EXACT_UNUSED_MESSAGES.has(
				diagnostic.message.trim().toLowerCase(),
			);
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
