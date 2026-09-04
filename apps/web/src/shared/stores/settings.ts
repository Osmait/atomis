import type { Language, WorkspaceScaffold } from "@atomis/protocol";
import { VALUE_FMTS, type ValueFmt } from "../lib/lowlevel.js";
import { WEB_LANGUAGE_PACKS } from "../../features/editor/languagePacks.js";
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
	/** Confine spawned processes to the workspace (server-enforced). */
	sandbox: boolean;
	/** Let the program itself reach the network from inside the sandbox. */
	network: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	autoRun: true,
	autoInspect: true,
	debounceMs: 400,
	timeoutMs: 2000,
	manualProbeIds: [],
	// The session response reports what the kernel supports; until then
	// assume it is on, so a run never escapes the sandbox by racing it.
	sandbox: true,
	network: false,
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

export const SETTINGS_KEY = "atomis.settings.v1";
const LAYOUT_KEY = "atomis.layout.v1";
export const VALUE_FMT_KEY = "atomis.value-fmt.v1";
export const VIM_MODE_KEY = "atomis.vim-mode.v1";
export const DEFAULT_TEMPLATE_KEY = "atomis.language.v1";
const SCAFFOLD_KEY = "atomis.scaffold.v1";
export const INLINE_LOGS_KEY = "atomis.inline-logs.v1";
const SOURCE_KEY = "atomis.source.v1";

/**
 * Server-enforced bounds (apps/server-rs/src/protocol.rs, settings.update).
 * They matter here because the stored blob is synced between devices: one
 * corrupt or out-of-range value — `debounceMs: 9999`, `timeoutMs: "2000"`
 * from another app version — would make the server refuse the WHOLE
 * settings.update on every connection, forever.
 */
const DEBOUNCE_MS_RANGE = [300, 500] as const;
const TIMEOUT_MS_RANGE = [100, 10_000] as const;

function clampRange(
	value: number,
	[min, max]: readonly [number, number],
): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** Keeps only fields of the right type, with numbers clamped into range. */
function sanitizeStoredSettings(raw: Partial<Settings>): Partial<Settings> {
	const out: Partial<Settings> = {};
	if (typeof raw.autoRun === "boolean") out.autoRun = raw.autoRun;
	if (typeof raw.autoInspect === "boolean") out.autoInspect = raw.autoInspect;
	if (typeof raw.sandbox === "boolean") out.sandbox = raw.sandbox;
	if (typeof raw.network === "boolean") out.network = raw.network;
	if (typeof raw.debounceMs === "number" && Number.isFinite(raw.debounceMs))
		out.debounceMs = clampRange(raw.debounceMs, DEBOUNCE_MS_RANGE);
	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs))
		out.timeoutMs = clampRange(raw.timeoutMs, TIMEOUT_MS_RANGE);
	return out;
}

export function loadSettings(): Settings {
	try {
		return {
			...DEFAULT_SETTINGS,
			...sanitizeStoredSettings(
				JSON.parse(readStoredItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>,
			),
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

/** Language scaffold used only when creating a new workspace or scratch session. */
export function loadDefaultTemplate(): Language {
	const stored = readStoredItem(DEFAULT_TEMPLATE_KEY);
	return stored && stored in WEB_LANGUAGE_PACKS ? (stored as Language) : "zig";
}

export function saveDefaultTemplate(language: Language): void {
	writeStoredItem(DEFAULT_TEMPLATE_KEY, language);
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

const ENTRY_SOURCE_DEBOUNCE_MS = 500;
let pendingEntrySource: string | undefined;
let entrySourceTimer: ReturnType<typeof setTimeout> | undefined;
let entrySourceFlushHooked = false;

/** Last entry-file source, restored when the session starts without files. */
export function loadEntrySource(): string | null {
	return pendingEntrySource ?? readStoredItem(SOURCE_KEY);
}

/** Writes whatever save is still waiting out its debounce, right now. */
export function flushEntrySourceNow(): void {
	if (entrySourceTimer !== undefined) {
		clearTimeout(entrySourceTimer);
		entrySourceTimer = undefined;
	}
	if (pendingEntrySource === undefined) return;
	const source = pendingEntrySource;
	pendingEntrySource = undefined;
	writeStoredItem(SOURCE_KEY, source);
}

/**
 * beforeunload covers reload and close; visibilitychange is what actually
 * fires when a tablet backgrounds the tab. Registered lazily and guarded
 * because the loaders are unit-tested without a DOM.
 */
function hookEntrySourceFlush(): void {
	if (entrySourceFlushHooked || typeof window === "undefined") return;
	entrySourceFlushHooked = true;
	window.addEventListener("beforeunload", flushEntrySourceNow);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushEntrySourceNow();
	});
}

/**
 * Called on every keystroke in the entry file, so it must not serialize the
 * whole source into localStorage synchronously each time — on a large file
 * that is per-key jank. Debounced, with the unload/hidden hooks above so
 * the last half-second of typing is not lost to the window.
 */
export function saveEntrySource(source: string): void {
	pendingEntrySource = source;
	hookEntrySourceFlush();
	if (entrySourceTimer !== undefined) clearTimeout(entrySourceTimer);
	entrySourceTimer = setTimeout(flushEntrySourceNow, ENTRY_SOURCE_DEBOUNCE_MS);
}
