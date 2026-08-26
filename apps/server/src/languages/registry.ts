import { cp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "@ziglive/protocol";
import { defaultRustSource, defaultSource } from "@ziglive/protocol";
import type { LanguageRunner } from "../compiler/CompilerRunner.js";
import { CompilerRunner } from "../compiler/CompilerRunner.js";
import { RustCompilerRunner } from "../compiler/RustCompilerRunner.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "../../../..");

export interface ToolCheck {
	command: string;
	args: string[];
	/** true when the detected version string enables the capability */
	compatible(version: string): boolean;
	expected: string;
}

export interface LanguagePack {
	id: Language;
	extensions: readonly string[];
	entryFile: string;
	defaultSource: string;
	/** scaffold even when the toolchain is missing (degraded sessions) */
	scaffoldAlways: boolean;
	scaffold(root: string): Promise<void>;
	instrumenterPath(): string;
	createRunner(
		supervisor: ProcessSupervisor,
		instrumenter: string,
	): LanguageRunner;
	lsp?: { command: string; args(root: string): string[] };
	toolchain: { run: ToolCheck; lsp?: ToolCheck };
}

export function cargoCompatible(version: string): boolean {
	const match = /cargo (\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 1 || (major === 1 && minor >= 75);
}

const zigPack: LanguagePack = {
	id: "zig",
	extensions: [".zig"],
	entryFile: "main.zig",
	defaultSource,
	scaffoldAlways: true,
	async scaffold(root) {
		await cp(
			join(PROJECT_ROOT, "zig/session-template/build.zig"),
			join(root, "build.zig"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/session-template/build.zig.zon"),
			join(root, "build.zig.zon"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/session-template/zls.json"),
			join(root, "zls.json"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/runtime/runzig_runtime.zig"),
			join(root, "generated/runzig_runtime.zig"),
		);
		await cp(
			join(PROJECT_ROOT, "zig/test-runner/runzig_test_runner.zig"),
			join(root, "runzig_test_runner.zig"),
		);
		await writeFile(join(root, "test_root.zig"), "comptime {}\n", {
			encoding: "utf8",
			mode: 0o600,
		});
	},
	instrumenterPath: () =>
		join(PROJECT_ROOT, "zig-out", "bin", "runzig-instrument"),
	createRunner: (supervisor, instrumenter) =>
		new CompilerRunner(supervisor, instrumenter),
	lsp: {
		command: "zls",
		args: (root) => ["--config-path", `${root}/zls.json`],
	},
	toolchain: {
		run: {
			command: "zig",
			args: ["version"],
			compatible: (version) => /^0\.16\./.test(version),
			expected: "Zig 0.16.x",
		},
		lsp: {
			command: "zls",
			args: ["--version"],
			compatible: (version) => /^0\.16\./.test(version),
			expected: "ZLS 0.16.x",
		},
	},
};

const rustPack: LanguagePack = {
	id: "rust",
	extensions: [".rs"],
	entryFile: "main.rs",
	defaultSource: defaultRustSource,
	scaffoldAlways: false,
	async scaffold(root) {
		await cp(
			join(PROJECT_ROOT, "rust/session-template/Cargo.toml"),
			join(root, "Cargo.toml"),
		);
		await cp(
			join(PROJECT_ROOT, "rust/runtime/ziglive_runtime.rs"),
			join(root, "generated/ziglive_runtime.rs"),
		);
	},
	instrumenterPath: () =>
		join(
			PROJECT_ROOT,
			"rust",
			"instrumenter",
			"target",
			"release",
			"rustlive-instrument",
		),
	createRunner: (supervisor, instrumenter) =>
		new RustCompilerRunner(supervisor, instrumenter),
	lsp: { command: "rust-analyzer", args: () => [] },
	toolchain: {
		run: {
			command: "cargo",
			args: ["--version"],
			compatible: cargoCompatible,
			expected: "Rust 1.75+",
		},
		lsp: {
			command: "rust-analyzer",
			args: ["--version"],
			compatible: (version) => /^rust-analyzer/.test(version),
			expected: "rust-analyzer",
		},
	},
};

export const LANGUAGE_PACKS: Record<Language, LanguagePack> = {
	zig: zigPack,
	rust: rustPack,
};

export function packForPath(path: string): LanguagePack | undefined {
	return Object.values(LANGUAGE_PACKS).find((pack) =>
		pack.extensions.some((extension) => path.endsWith(extension)),
	);
}
