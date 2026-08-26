import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detected: string;
	expected: string;
	command: string;
	help?: string;
}

function command(
	command: string,
	args: string[],
	cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) =>
			resolve({ code: null, stdout, stderr: error.message }),
		);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

export async function runDoctor(): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	checks.push({
		name: "Node.js",
		ok: nodeMajor >= 22 && nodeMajor < 25,
		detected: process.versions.node,
		expected: "22.x production baseline (22–24 accepted for development)",
		command: "node --version",
		help: "Install Node 22, then run: corepack enable && pnpm run doctor",
	});

	for (const tool of ["zig", "zls"] as const) {
		const result = await command(tool, [
			tool === "zig" ? "version" : "--version",
		]);
		const detected =
			result.stdout.trim() || result.stderr.trim() || "not found";
		checks.push({
			name: tool === "zig" ? "Zig compiler" : "ZLS language server",
			ok: result.code === 0 && /^0\.16\./.test(detected),
			detected,
			expected: "0.16.x",
			command: tool === "zig" ? "zig version" : "zls --version",
			help: `Install ${tool} 0.16.x on PATH. ZigLive never downloads it automatically.`,
		});
	}

	for (const tool of ["rustc", "cargo", "rust-analyzer"] as const) {
		const result = await command(tool, ["--version"]);
		const detected =
			result.stdout.trim().split("\n")[0] ||
			result.stderr.trim() ||
			"not found";
		checks.push({
			name: `Rust ${tool}`,
			ok: true,
			detected:
				result.code === 0 ? detected : `${detected} — Rust sessions disabled`,
			expected:
				tool === "rust-analyzer"
					? "any (optional, enables Rust editor features)"
					: "1.75+ (optional, enables Rust sessions)",
			command: `${tool} --version`,
		});
	}

	const directory = await mkdtemp(join(tmpdir(), "ziglive-doctor-"));
	try {
		await writeFile(join(directory, "main.zig"), "pub fn main() void {}\n");
		const compile = await command(
			"zig",
			["build-exe", "main.zig", "-femit-bin=doctor-bin"],
			directory,
		);
		let execute = {
			code: null as number | null,
			stdout: "",
			stderr: "compile failed",
		};
		if (compile.code === 0)
			execute = await command(join(directory, "doctor-bin"), [], directory);
		checks.push({
			name: "Native compile/run",
			ok: compile.code === 0 && execute.code === 0,
			detected:
				compile.code === 0
					? `exit ${String(execute.code)}`
					: compile.stderr.trim(),
			expected: "temporary binary exits 0",
			command: "zig build-exe main.zig -femit-bin=doctor-bin",
			help: "Check compiler/linker availability and executable temp mounts.",
		});
		let writable = true;
		try {
			await access(directory, constants.W_OK);
		} catch {
			writable = false;
		}
		checks.push({
			name: "Temporary storage",
			ok: writable,
			detected: directory,
			expected: "writable",
			command: `test -w ${directory}`,
		});

		const fdProgram = join(directory, "fd3.mjs");
		await writeFile(
			fdProgram,
			"import { writeSync } from 'node:fs'; writeSync(3, 'probe\\n');\n",
		);
		const fdResult = await new Promise<{ code: number | null; probe: string }>(
			(resolve) => {
				const child = spawn(process.execPath, [fdProgram], {
					stdio: ["ignore", "ignore", "pipe", "pipe"],
				});
				let probe = "";
				const fd3 = child.stdio[3];
				if (fd3 && "setEncoding" in fd3)
					fd3.setEncoding("utf8").on("data", (chunk: string) => {
						probe += chunk;
					});
				child.once("close", (code) => resolve({ code, probe }));
			},
		);
		checks.push({
			name: "Probe descriptor fd 3",
			ok: fdResult.code === 0 && fdResult.probe === "probe\n",
			detected: JSON.stringify(fdResult),
			expected: "separate inherited pipe",
			command: "node fd3.mjs (stdio[3]=pipe)",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	return checks;
}

async function main(): Promise<void> {
	const checks = await runDoctor();
	console.log("ZigLive doctor\n");
	for (const check of checks) {
		console.log(`${check.ok ? "✓" : "✗"} ${check.name}`);
		console.log(`  detected: ${check.detected}`);
		console.log(`  expected: ${check.expected}`);
		console.log(`  command:  ${check.command}`);
		if (!check.ok && check.help) console.log(`  fix:      ${check.help}`);
	}
	console.log("\nRe-run with: pnpm run doctor");
	if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
