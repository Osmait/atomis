import { dirname } from "node:path";
import type { AppDiagnostic, ProbeDescriptor } from "@ziglive/protocol";

type ProjectDiagnostic = AppDiagnostic & { path?: string };

const COMPILER_LOCATION = /^(.*\.zig):(\d+):(\d+): (error|warning|note): (.+)$/;

function generatedPathAliases(generatedPath: string): string[] {
	const normalized = generatedPath.replaceAll("\\", "/");
	const relative = normalized.split("/").slice(-2).join("/");
	return relative === normalized ? [normalized] : [normalized, relative];
}

function generatedProjectPath(
	path: string,
	generatedPath: string,
): string | undefined {
	const normalized = path.replaceAll("\\", "/");
	const root = dirname(generatedPath).replaceAll("\\", "/");
	if (normalized.startsWith(`${root}/`))
		return `src/${normalized.slice(root.length + 1)}`;
	const marker = "generated/";
	const markerIndex = normalized.lastIndexOf(marker);
	if (markerIndex >= 0) return `src/${normalized.slice(markerIndex + marker.length)}`;
	if (generatedPathAliases(generatedPath).includes(normalized))
		return `src/${normalized.split("/").at(-1) ?? "main.zig"}`;
	return undefined;
}

function generatedReference(
	line: string,
	generatedPath: string,
): { path: string; line: number; column: number } | undefined {
	const locations = line.matchAll(/([^\s:]*\.zig):(\d+):(\d+)/g);
	for (const location of locations) {
		const [, path, lineText, columnText] = location;
		if (!path || !lineText || !columnText) continue;
		const projectPath = generatedProjectPath(path, generatedPath);
		if (projectPath)
			return {
				path: projectPath,
				line: Number(lineText),
				column: Number(columnText),
			};
	}
	return undefined;
}

function findGeneratedReference(
	lines: string[],
	startIndex: number,
	generatedPath: string,
): { path: string; line: number; column: number } | undefined {
	for (let index = startIndex; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined) return undefined;
		const diagnostic = COMPILER_LOCATION.exec(line);
		if (diagnostic?.[4] === "error" || diagnostic?.[4] === "warning")
			return undefined;
		const reference = generatedReference(line, generatedPath);
		if (reference) return reference;
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
): ProjectDiagnostic[] {
	const diagnostics: ProjectDiagnostic[] = [];
	const lines = stderr.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		const match = COMPILER_LOCATION.exec(line);
		if (!match) continue;
		const [, path, lineText, columnText, level, message] = match;
		if (!path || !lineText || !columnText || !level || !message) continue;
		const projectPath = generatedProjectPath(path, generatedPath);
		const reference = projectPath
			? undefined
			: findGeneratedReference(lines, index + 1, generatedPath);
		const diagnosticPath = reference?.path ?? projectPath;
		diagnostics.push({
			...(diagnosticPath ? { path: diagnosticPath } : {}),
			message: projectPath ? message : `${message} (${path})`,
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
