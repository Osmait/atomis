import type { Language } from "@ziglive/protocol";
import type * as Monaco from "monaco-editor";
import { registerGo } from "./editor/goLanguage.js";
import { registerRust } from "./editor/rustLanguage.js";
import { registerZig } from "./editor/zigLanguage.js";

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
