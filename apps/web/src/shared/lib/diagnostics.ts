import type { AppDiagnostic } from "@atomis/protocol";

/**
 * Diagnostic aggregation shared by the problems panel, the error lens and
 * the status bar: flattening per-owner diagnostics with cross-owner dedupe,
 * grouping by line for the lens, and severity ordering.
 */
export type ProjectDiagnostic = AppDiagnostic & { path?: string };

export interface OwnedDiagnostic extends ProjectDiagnostic {
	owner: string;
}

export const SEVERITY_RANK: Record<AppDiagnostic["severity"], number> = {
	error: 4,
	warning: 3,
	information: 2,
	hint: 1,
};

/** Document path a diagnostic belongs to; entry-file when unattributed. */
export function diagnosticDocPath(
	diagnostic: ProjectDiagnostic,
	entryFile: string,
): string {
	return diagnostic.path ?? `src/${entryFile}`;
}

/**
 * Flattens `{owner: diagnostics}` into one list, dropping diagnostics that
 * repeat another owner's severity+position+message (compiler vs LSP overlap).
 */
export function flattenProblems(
	byOwner: Record<string, readonly ProjectDiagnostic[]>,
): OwnedDiagnostic[] {
	const seen = new Set<string>();
	return Object.entries(byOwner).flatMap(([owner, items]) =>
		items.flatMap((item) => {
			const key = `${item.severity}:${item.line}:${item.column}:${item.message}`;
			if (seen.has(key)) return [];
			seen.add(key);
			return [{ owner, ...item }];
		}),
	);
}

/**
 * Groups the active file's diagnostics by line for the error lens, keeping
 * one entry per distinct message+severity and dropping lines outside the
 * model.
 */
export function problemsByLine(
	problems: readonly OwnedDiagnostic[],
	options: { activePath: string; entryFile: string; lineCount: number },
): Map<number, OwnedDiagnostic[]> {
	const byLine = new Map<number, OwnedDiagnostic[]>();
	for (const diagnostic of problems) {
		if (
			diagnosticDocPath(diagnostic, options.entryFile) !==
				`src/${options.activePath}` ||
			diagnostic.line < 1 ||
			diagnostic.line > options.lineCount
		)
			continue;
		const lineDiagnostics = byLine.get(diagnostic.line) ?? [];
		if (
			!lineDiagnostics.some(
				(item) =>
					item.message === diagnostic.message &&
					item.severity === diagnostic.severity,
			)
		)
			lineDiagnostics.push(diagnostic);
		byLine.set(diagnostic.line, lineDiagnostics);
	}
	return byLine;
}

/** Highest-severity diagnostic of a line (error > warning > info > hint). */
export function primaryDiagnostic(
	lineDiagnostics: readonly OwnedDiagnostic[],
): OwnedDiagnostic {
	const sorted = lineDiagnostics.toSorted(
		(left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity],
	);
	return sorted[0]!;
}

export function severityColor(severity: AppDiagnostic["severity"]): string {
	return severity === "error"
		? "#f14c4c"
		: severity === "warning"
			? "#cca700"
			: "#3794ff";
}
