import type { AppDiagnostic } from "@ziglive/protocol";

type ProjectDiagnostic = AppDiagnostic & { path?: string };

interface CargoSpan {
	file_name?: string;
	line_start?: number;
	line_end?: number;
	column_start?: number;
	column_end?: number;
	is_primary?: boolean;
}

interface CargoMessage {
	reason?: string;
	message?: {
		level?: string;
		message?: string;
		code?: { code?: string } | null;
		spans?: CargoSpan[];
	};
}

function severity(level: string): AppDiagnostic["severity"] | undefined {
	if (level === "error" || level.startsWith("error")) return "error";
	if (level === "warning") return "warning";
	return undefined;
}

function projectPath(fileName: string): string | undefined {
	const normalized = fileName.replaceAll("\\", "/");
	if (normalized.startsWith("generated/"))
		return `src/${normalized.slice("generated/".length)}`;
	if (normalized.startsWith("src/")) return normalized;
	const marker = normalized.lastIndexOf("/generated/");
	if (marker >= 0)
		return `src/${normalized.slice(marker + "/generated/".length)}`;
	const sourceMarker = normalized.lastIndexOf("/src/");
	if (sourceMarker >= 0) return normalized.slice(sourceMarker + 1);
	return undefined;
}

/**
 * Parses `cargo … --message-format=json` stdout (one JSON object per line)
 * into project diagnostics. Spans of the instrumented mirror map back to the
 * visible `src/` path, which is safe because the generated copy preserves the
 * exact line numbering of the original file.
 */
export function parseCargoDiagnostics(stdout: string): ProjectDiagnostic[] {
	const diagnostics: ProjectDiagnostic[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		let parsed: CargoMessage;
		try {
			parsed = JSON.parse(line) as CargoMessage;
		} catch {
			continue;
		}
		if (parsed.reason !== "compiler-message") continue;
		const message = parsed.message;
		if (!message?.message) continue;
		const level = severity(message.level ?? "");
		if (!level) continue;
		if (/aborting due to \d+ previous error/.test(message.message)) continue;
		const primary =
			message.spans?.find((span) => span.is_primary) ?? message.spans?.[0];
		if (!primary?.file_name || !primary.line_start) continue;
		const path = projectPath(primary.file_name);
		diagnostics.push({
			...(path ? { path } : {}),
			message: message.message,
			severity: level,
			line: primary.line_start,
			column: primary.column_start ?? 1,
			...(primary.line_end ? { endLine: primary.line_end } : {}),
			...(primary.column_end ? { endColumn: primary.column_end } : {}),
			...(message.code?.code ? { code: message.code.code } : {}),
			source: "rustc",
		});
	}
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.path ?? ""}:${diagnostic.line}:${diagnostic.column}:${diagnostic.severity}:${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
