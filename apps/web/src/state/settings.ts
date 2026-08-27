import type { Language, WorkspaceScaffold } from "@atomis/protocol";
import { VALUE_FMTS, type ValueFmt } from "../lowlevel.js";
import { WEB_LANGUAGE_PACKS } from "../languages.js";
import { readStoredItem, writeStoredItem } from "./storage.js";

/**
 * Behaviour settings and layout state persisted in localStorage. Loaders
 * validate what they read and fall back to defaults; savers strip the
 * per-session pieces (manual probes) that must not survive a reload.
 */
export interface Settings {
	autoRun: boolean;
	autoInspect: boolean;
	debounceMs: number;
	timeoutMs: number;
	manualProbeIds: string[];
}

export const DEFAULT_SETTINGS: Settings = {
	autoRun: true,
	autoInspect: true,
	debounceMs: 400,
	timeoutMs: 2000,
	manualProbeIds: [],
};

export interface LayoutState {
	dock: "right" | "bottom";
	treeOpen: boolean;
	termOpen: boolean;
	termMax: boolean;
	zen: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
	dock: "right",
	treeOpen: true,
	termOpen: true,
	termMax: false,
	zen: false,
};

const SETTINGS_KEY = "atomis.settings.v1";
const LAYOUT_KEY = "atomis.layout.v1";
const VALUE_FMT_KEY = "atomis.value-fmt.v1";
const VIM_MODE_KEY = "atomis.vim-mode.v1";
const LANGUAGE_KEY = "atomis.language.v1";
const SCAFFOLD_KEY = "atomis.scaffold.v1";
const INLINE_LOGS_KEY = "atomis.inline-logs.v1";
const SOURCE_KEY = "atomis.source.v1";

export function loadSettings(): Settings {
	try {
		return {
			...DEFAULT_SETTINGS,
			...(JSON.parse(
				readStoredItem(SETTINGS_KEY) ?? "{}",
			) as Partial<Settings>),
			manualProbeIds: [],
		};
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(settings: Settings): void {
	writeStoredItem(
		SETTINGS_KEY,
		JSON.stringify({ ...settings, manualProbeIds: [] }),
	);
}

export function loadLayout(): LayoutState {
	try {
		return {
			...DEFAULT_LAYOUT,
			...(JSON.parse(
				readStoredItem(LAYOUT_KEY) ?? "{}",
			) as Partial<LayoutState>),
		};
	} catch {
		return DEFAULT_LAYOUT;
	}
}

export function saveLayout(layout: LayoutState): void {
	writeStoredItem(LAYOUT_KEY, JSON.stringify(layout));
}

export function loadValueFmt(): ValueFmt {
	const stored = readStoredItem(VALUE_FMT_KEY);
	return VALUE_FMTS.includes(stored as ValueFmt) ? (stored as ValueFmt) : "dec";
}

export function saveValueFmt(fmt: ValueFmt): void {
	writeStoredItem(VALUE_FMT_KEY, fmt);
}

export function loadVimMode(): boolean {
	return readStoredItem(VIM_MODE_KEY) !== "false";
}

export function saveVimMode(enabled: boolean): void {
	writeStoredItem(VIM_MODE_KEY, String(enabled));
}

export function loadLanguage(): Language {
	const stored = readStoredItem(LANGUAGE_KEY);
	return stored && stored in WEB_LANGUAGE_PACKS ? (stored as Language) : "zig";
}

export function saveLanguage(language: Language): void {
	writeStoredItem(LANGUAGE_KEY, language);
}

/**
 * Workspace scaffold for new sessions: "minimal" (the default) starts with
 * just the chosen language's entry file; "demo" loads every language's
 * example workspace.
 */
export function loadScaffold(): WorkspaceScaffold {
	return readStoredItem(SCAFFOLD_KEY) === "demo" ? "demo" : "minimal";
}

export function saveScaffold(scaffold: WorkspaceScaffold): void {
	writeStoredItem(SCAFFOLD_KEY, scaffold);
}

/** Console Ninja-style inline logs in the editor (on by default). */
export function loadInlineLogs(): boolean {
	return readStoredItem(INLINE_LOGS_KEY) !== "false";
}

export function saveInlineLogs(enabled: boolean): void {
	writeStoredItem(INLINE_LOGS_KEY, String(enabled));
}

/** Last entry-file source, restored when the session starts without files. */
export function loadEntrySource(): string | null {
	return readStoredItem(SOURCE_KEY);
}

export function saveEntrySource(source: string): void {
	writeStoredItem(SOURCE_KEY, source);
}
