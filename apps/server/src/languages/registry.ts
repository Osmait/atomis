import { cp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "@ziglive/protocol";
import {
	defaultCSource,
	defaultCTestSource,
	defaultCppSource,
	defaultCppTestSource,
	defaultGoSource,
	defaultGoTestSource,
	defaultPySource,
	defaultPyTestSource,
	defaultRustSource,
	defaultSource,
	defaultTsSource,
	defaultTsTestSource,
} from "@ziglive/protocol";
import type { LanguageRunner } from "../compiler/CompilerRunner.js";
import { CompilerRunner } from "../compiler/CompilerRunner.js";
import { GoCompilerRunner } from "../compiler/GoCompilerRunner.js";
import {
	CFamilyCompilerRunner,
	type CFamilyConfig,
} from "../compiler/CFamilyCompilerRunner.js";
import { PyCompilerRunner } from "../compiler/PyCompilerRunner.js";
import { TsCompilerRunner } from "../compiler/TsCompilerRunner.js";
import { RustCompilerRunner } from "../compiler/RustCompilerRunner.js";
import type { ProcessSupervisor } from "../processes/ProcessSupervisor.js";

// The desktop sidecar is a CJS single-executable where import.meta does not
// exist: it always sets ZIGLIVE_ROOT, so the fallback never evaluates there.
export const PROJECT_ROOT = process.env.ZIGLIVE_ROOT
	? resolve(process.env.ZIGLIVE_ROOT)
	: resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

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
	/** additional starter files created alongside the entry */
	extraFiles?: Record<string, string>;
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

const goPack: LanguagePack = {
	id: "go",
	extensions: [".go"],
	entryFile: "main.go",
	defaultSource: defaultGoSource,
	extraFiles: { "main_test.go": defaultGoTestSource },
	scaffoldAlways: false,
	async scaffold(root) {
		await cp(
			join(PROJECT_ROOT, "go/session-template/go.mod"),
			join(root, "go.mod"),
		);
		await cp(
			join(PROJECT_ROOT, "go/runtime/ziglive_runtime.go"),
			join(root, "generated/ziglive_runtime.go"),
		);
	},
	instrumenterPath: () =>
		join(PROJECT_ROOT, "go", "instrumenter", "bin", "golive-instrument"),
	createRunner: (supervisor, instrumenter) =>
		new GoCompilerRunner(supervisor, instrumenter),
	lsp: { command: "gopls", args: () => [] },
	toolchain: {
		run: {
			command: "go",
			args: ["version"],
			compatible: (version) => {
				const match = /go version go1\.(\d+)/.exec(version);
				return Boolean(match && Number(match[1]) >= 22);
			},
			expected: "Go 1.22+",
		},
		lsp: {
			command: "gopls",
			args: ["version"],
			compatible: (version) => /gopls/i.test(version),
			expected: "gopls",
		},
	},
};

export function nodeCompatible(version: string): boolean {
	const match = /v(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	// Type stripping ships enabled by default from 22.18 / 23.6 onward.
	return major >= 23 || (major === 22 && minor >= 18);
}

const tsPack: LanguagePack = {
	id: "ts",
	extensions: [".ts", ".js", ".mjs"],
	entryFile: "main.ts",
	defaultSource: defaultTsSource,
	extraFiles: { "main.test.ts": defaultTsTestSource },
	scaffoldAlways: false,
	async scaffold(root) {
		await cp(
			join(PROJECT_ROOT, "ts/session-template/package.json"),
			join(root, "package.json"),
		);
		await cp(
			join(PROJECT_ROOT, "ts/runtime/ziglive_runtime.mjs"),
			join(root, "generated/__ziglive_runtime.mjs"),
		);
		const typeRoots = join(PROJECT_ROOT, "node_modules", "@types").replaceAll(
			"\\",
			"/",
		);
		await writeFile(
			join(root, "tsconfig.json"),
			`${JSON.stringify(
				{
					compilerOptions: {
						strict: true,
						noEmit: true,
						target: "ES2023",
						module: "nodenext",
						moduleResolution: "nodenext",
						allowImportingTsExtensions: true,
						skipLibCheck: true,
						allowJs: true,
						typeRoots: [typeRoots],
						types: ["node"],
					},
					include: ["src"],
				},
				null,
				"\t",
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	},
	instrumenterPath: () =>
		join(PROJECT_ROOT, "ts", "instrumenter", "instrument.mjs"),
	createRunner: (supervisor, instrumenter) =>
		new TsCompilerRunner(supervisor, instrumenter),
	lsp: { command: "typescript-language-server", args: () => ["--stdio"] },
	toolchain: {
		run: {
			command: "node",
			args: ["--version"],
			compatible: nodeCompatible,
			expected: "Node 22.18+ (type stripping)",
		},
		lsp: {
			command: "typescript-language-server",
			args: ["--version"],
			compatible: (version) => /\d/.test(version),
			expected: "typescript-language-server",
		},
	},
};

const pyPack: LanguagePack = {
	id: "py",
	extensions: [".py"],
	entryFile: "main.py",
	defaultSource: defaultPySource,
	extraFiles: { "main_test.py": defaultPyTestSource },
	scaffoldAlways: false,
	async scaffold(root) {
		await cp(
			join(PROJECT_ROOT, "python/runtime/sitecustomize.py"),
			join(root, "generated/sitecustomize.py"),
		);
	},
	instrumenterPath: () =>
		join(PROJECT_ROOT, "python", "instrumenter", "pylive_instrument.py"),
	createRunner: (supervisor, instrumenter) =>
		new PyCompilerRunner(supervisor, instrumenter),
	lsp: { command: "pyright-langserver", args: () => ["--stdio"] },
	toolchain: {
		run: {
			command: "python3",
			args: ["--version"],
			compatible: (version) => {
				const match = /Python 3\.(\d+)/.exec(version);
				return Boolean(match && Number(match[1]) >= 9);
			},
			expected: "Python 3.9+",
		},
		lsp: {
			command: "pyright-langserver",
			args: ["--version"],
			compatible: (version) => /\d/.test(version),
			expected: "pyright-langserver",
		},
	},
};

function cFamilyPack(config: CFamilyConfig, options: {
	entryFile: string;
	defaultSource: string;
	extraFiles: Record<string, string>;
	extensions: readonly string[];
}): LanguagePack {
	return {
		id: config.language,
		extensions: options.extensions,
		entryFile: options.entryFile,
		defaultSource: options.defaultSource,
		extraFiles: options.extraFiles,
		scaffoldAlways: false,
		async scaffold(root) {
			await cp(
				join(PROJECT_ROOT, "cfamily/runtime", config.runtimeHeader),
				join(root, "generated", config.runtimeHeader),
			);
		},
		instrumenterPath: () =>
			join(PROJECT_ROOT, "cfamily", "instrumenter", "clive-instrument.mjs"),
		createRunner: (supervisor, instrumenter) =>
			new CFamilyCompilerRunner(supervisor, instrumenter, config),
		lsp: { command: "clangd", args: () => [] },
		toolchain: {
			run: {
				command: config.compiler,
				args: ["--version"],
				compatible: (version) => {
					const match = /clang version (\d+)/.exec(version);
					return Boolean(match && Number(match[1]) >= 15);
				},
				expected: `${config.compiler} 15+`,
			},
			lsp: {
				command: "clangd",
				args: ["--version"],
				compatible: (version) => /clangd/i.test(version),
				expected: "clangd",
			},
		},
	};
}

const cPack = cFamilyPack(
	{
		language: "c",
		compiler: "clang",
		std: "c17",
		codeFile: /\.c$/,
		testFile: /_test\.c$/,
		runtimeHeader: "ziglive_runtime.h",
		testMainName: "__ziglive_test_main.c",
	},
	{
		entryFile: "main.c",
		defaultSource: defaultCSource,
		extraFiles: { "main_test.c": defaultCTestSource },
		extensions: [".c"],
	},
);

const cppPack = cFamilyPack(
	{
		language: "cpp",
		compiler: "clang++",
		std: "c++20",
		codeFile: /\.(cpp|cc)$/,
		testFile: /_test\.(cpp|cc)$/,
		runtimeHeader: "ziglive_runtime.hpp",
		testMainName: "__ziglive_test_main.cpp",
	},
	{
		entryFile: "main.cpp",
		defaultSource: defaultCppSource,
		extraFiles: { "main_test.cpp": defaultCppTestSource },
		extensions: [".cpp", ".cc"],
	},
);

export const LANGUAGE_PACKS: Record<Language, LanguagePack> = {
	zig: zigPack,
	rust: rustPack,
	go: goPack,
	ts: tsPack,
	py: pyPack,
	c: cPack,
	cpp: cppPack,
};

export function packForPath(path: string): LanguagePack | undefined {
	return Object.values(LANGUAGE_PACKS).find((pack) =>
		pack.extensions.some((extension) => path.endsWith(extension)),
	);
}
