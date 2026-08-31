import type { Language } from "@atomis/protocol";
import type * as Monaco from "monaco-editor";
import { registerC } from "./languages/cLanguage.js";
import { registerGo } from "./languages/goLanguage.js";
import { registerPy } from "./languages/pyLanguage.js";
import { registerTs } from "./languages/tsLanguage.js";
import { registerRust } from "./languages/rustLanguage.js";
import { registerZig } from "./languages/zigLanguage.js";

export interface WebLanguagePack {
	id: Language;
	extensions: readonly string[];
	entryFile: string;
	/** Monaco language id used for models and providers */
	monacoId: string;
	serverName: string;
	runCommand: string;
	testCommand: string;
	register(monaco: typeof Monaco): void;
}

export const WEB_LANGUAGE_PACKS: Record<Language, WebLanguagePack> = {
	zig: {
		id: "zig",
		extensions: [".zig"],
		entryFile: "main.zig",
		monacoId: "zig",
		serverName: "zls",
		runCommand: "zig build run",
		testCommand: "zig test",
		register: registerZig,
	},
	rust: {
		id: "rust",
		extensions: [".rs"],
		entryFile: "main.rs",
		monacoId: "rust",
		serverName: "rust-analyzer",
		runCommand: "cargo run",
		testCommand: "cargo test",
		register: registerRust,
	},
	go: {
		id: "go",
		extensions: [".go"],
		entryFile: "main.go",
		monacoId: "go",
		serverName: "gopls",
		runCommand: "go run",
		testCommand: "go test",
		register: registerGo,
	},
	ts: {
		id: "ts",
		extensions: [".ts", ".js", ".mjs", ".cjs"],
		entryFile: "main.ts",
		monacoId: "typescript",
		serverName: "tsserver",
		runCommand: "node main.ts",
		testCommand: "node --test",
		register: registerTs,
	},
	py: {
		id: "py",
		extensions: [".py"],
		entryFile: "main.py",
		monacoId: "python",
		serverName: "pyright",
		runCommand: "python3 main.py",
		testCommand: "python3 tests",
		register: registerPy,
	},
	c: {
		id: "c",
		extensions: [".c"],
		entryFile: "main.c",
		monacoId: "c",
		serverName: "clangd",
		runCommand: "clang main.c && ./a.out",
		testCommand: "tests",
		register: registerC,
	},
	cpp: {
		id: "cpp",
		extensions: [".cpp", ".cc"],
		entryFile: "main.cpp",
		monacoId: "cpp",
		serverName: "clangd",
		runCommand: "clang++ main.cpp && ./a.out",
		testCommand: "tests",
		register: () => {},
	},
};

export const ENTRY_FILES = new Set(
	Object.values(WEB_LANGUAGE_PACKS).map((pack) => pack.entryFile),
);

export function languageForPath(path: string): Language | undefined {
	return Object.values(WEB_LANGUAGE_PACKS).find((pack) =>
		pack.extensions.some((extension) => path.endsWith(extension)),
	)?.id;
}

export function registerAllLanguages(monaco: typeof Monaco): void {
	for (const pack of Object.values(WEB_LANGUAGE_PACKS)) pack.register(monaco);
}

/**
 * Monaco language id for any project path: session languages by extension
 * (plain `.js`/`.mjs` files edit as javascript), plus the asset types the
 * tree can hold.
 */
export function monacoLanguageFor(path: string): string {
	const language = languageForPath(path);
	if (language)
		return /\.(js|mjs|cjs)$/.test(path)
			? "javascript"
			: WEB_LANGUAGE_PACKS[language].monacoId;
	if (path.endsWith(".json")) return "json";
	if (path.endsWith(".md")) return "markdown";
	if (path.endsWith(".h")) return "c";
	if (path.endsWith(".hpp")) return "cpp";
	return "plaintext";
}
