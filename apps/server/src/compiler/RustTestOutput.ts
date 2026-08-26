export interface LibtestLine {
	name: string;
	status: "ok" | "FAILED" | "ignored";
}

const RESULT_LINE = /^test (\S+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$/;
const SUMMARY_LINE =
	/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/m;

export function parseLibtestLine(line: string): LibtestLine | undefined {
	const match = RESULT_LINE.exec(line.trim());
	if (!match?.[1] || !match[2]) return undefined;
	return { name: match[1], status: match[2] as LibtestLine["status"] };
}

/**
 * Extracts the `---- name stdout ----` failure blocks libtest prints at the
 * end of a run, keyed by the qualified test name.
 */
export function extractFailureMessages(stdout: string): Map<string, string> {
	const messages = new Map<string, string>();
	const pattern = /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- \S+ stdout ----$|^failures:$|^note:)/gm;
	for (const match of stdout.matchAll(pattern)) {
		if (match[1] && match[2] !== undefined)
			messages.set(match[1], match[2].trim().slice(0, 1200));
	}
	return messages;
}

export function parseLibtestSummary(
	stdout: string,
): { passed: number; failed: number; ignored: number } | undefined {
	const match = SUMMARY_LINE.exec(stdout);
	if (!match) return undefined;
	return {
		passed: Number(match[1]),
		failed: Number(match[2]),
		ignored: Number(match[3]),
	};
}

interface CargoArtifact {
	reason?: string;
	executable?: string | null;
	profile?: { test?: boolean };
	target?: { name?: string };
}

export function findTestExecutable(
	stdout: string,
	targetName: string,
): string | undefined {
	let executable: string | undefined;
	for (const line of stdout.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		let parsed: CargoArtifact;
		try {
			parsed = JSON.parse(line) as CargoArtifact;
		} catch {
			continue;
		}
		if (
			parsed.reason === "compiler-artifact" &&
			parsed.profile?.test &&
			parsed.target?.name === targetName &&
			parsed.executable
		)
			executable = parsed.executable;
	}
	return executable;
}
