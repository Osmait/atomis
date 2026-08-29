import { readStoredItem, writeStoredItem } from "./storage.js";
import {
	DEFAULT_FONT,
	DEFAULT_SIZE,
	isAppSize,
	MONO_FONTS,
} from "./fonts.js";
import {
	DEFAULT_THEME,
	isAppTheme,
	THEME_IDS,
	THEMES,
	type AppTheme,
} from "./themes.js";

/**
 * Appearance preferences: theme, typography and the leader key. The option
 * catalogs live next to the persistence code so stored values can be
 * validated; the settings modal renders these same catalogs. The palettes
 * themselves live in themes.ts, which also generates what the window and
 * the editor are painted with.
 */

/** Every theme, in the order the settings dialog lists them. */
export const APP_THEMES = THEME_IDS.map((id) => ({
	id,
	label: THEMES[id].label,
	palette: THEMES[id],
}));

export type { AppTheme };


/**
 * The leader is stored as the `KeyboardEvent.key` it matches, so any key can
 * be one. These are only the one-click presets.
 */
export const LEADER_OPTIONS = [
	{ key: " ", label: "Space" },
	{ key: ",", label: "Comma ," },
	{ key: "\\", label: "Backslash \\" },
] as const;

/** A `KeyboardEvent.key`. */
export type LeaderKey = string;

export const DEFAULT_LEADER: LeaderKey = " ";

/** What the settings dialog stored before any key was allowed. */
const LEGACY_LEADERS: Record<string, string> = {
	space: " ",
	comma: ",",
	backslash: "\\",
};

/**
 * A modifier alone never reaches the navigation core (it short-circuits on
 * `hasModifier`), and Escape is what cancels the capture and closes the
 * dialog, so neither can be the leader. Everything else is fair game —
 * an awkward choice stays reachable because ⌘, carries a modifier and so
 * bypasses the leader entirely.
 */
const UNUSABLE_LEADERS = new Set([
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"AltGraph",
	"CapsLock",
	"Escape",
	"Dead",
	"Unidentified",
]);

/**
 * The multi-character `KeyboardEvent.key` values worth offering. The list
 * matters: without it any stored string would pass, and a leader that no
 * key event can ever equal is one that silently never fires.
 */
const NAMED_LEADERS = new Set([
	"Tab",
	"Enter",
	"Backspace",
	"Delete",
	"Insert",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
]);

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

export function isUsableLeader(key: string): boolean {
	if (UNUSABLE_LEADERS.has(key)) return false;
	// Any single character, so a comma, an ñ or a º all work.
	if ([...key].length === 1) return true;
	return NAMED_LEADERS.has(key) || FUNCTION_KEY.test(key);
}

/** Migrates a legacy option id, and falls back for anything unusable. */
export function normalizeLeader(stored: string | undefined): LeaderKey {
	if (stored === undefined) return DEFAULT_LEADER;
	const migrated = LEGACY_LEADERS[stored] ?? stored;
	return isUsableLeader(migrated) ? migrated : DEFAULT_LEADER;
}

/**
 * How a key is named in the UI. `KeyboardEvent.key` is already readable for
 * the named keys ("Tab", "Enter", "ArrowUp"); only a space needs help.
 */
export function leaderLabel(key: LeaderKey): string {
	return key === " " ? "Space" : key;
}

export interface Appearance {
	theme: AppTheme;
	/** A MONO_FONTS id. Stored by name, not position, so the catalog can
	 * grow and reorder without silently changing everyone's font. */
	font: string;
	/** Type size in px. */
	fontSize: number;
	leader: LeaderKey;
}

/** Order of the three fonts offered before the catalog grew. */
const LEGACY_FONTS = ["jetbrains", "plex", "sfmono"];
/** Sizes 12–15, which is what a stored index pointed into. */
const LEGACY_SIZES = [12, 13, 14, 15];

/** Reads the font id, migrating a stored `fontIndex` from the old format. */
function normalizeFont(stored: Partial<Appearance> & { fontIndex?: number }): string {
	if (typeof stored.font === "string" && MONO_FONTS.some((f) => f.id === stored.font))
		return stored.font;
	if (typeof stored.fontIndex === "number")
		return LEGACY_FONTS[stored.fontIndex] ?? DEFAULT_FONT;
	return DEFAULT_FONT;
}

/** Reads the size in px, migrating a stored `sizeIndex` from the old format. */
function normalizeSize(stored: Partial<Appearance> & { sizeIndex?: number }): number {
	if (typeof stored.fontSize === "number" && isAppSize(stored.fontSize))
		return stored.fontSize;
	if (typeof stored.sizeIndex === "number")
		return LEGACY_SIZES[stored.sizeIndex] ?? DEFAULT_SIZE;
	return DEFAULT_SIZE;
}

export const DEFAULT_APPEARANCE: Appearance = {
	theme: DEFAULT_THEME,
	font: DEFAULT_FONT,
	fontSize: DEFAULT_SIZE,
	leader: DEFAULT_LEADER,
};

export const APPEARANCE_KEY = "atomis.appearance.v1";

export function loadAppearance(): Appearance {
	try {
		const stored = JSON.parse(
			readStoredItem(APPEARANCE_KEY) ?? "{}",
		) as Partial<Appearance> & { fontIndex?: number; sizeIndex?: number };
		return {
			theme: isAppTheme(stored.theme) ? stored.theme : DEFAULT_THEME,
			font: normalizeFont(stored),
			fontSize: normalizeSize(stored),
			leader: normalizeLeader(stored.leader),
		};
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

export function saveAppearance(appearance: Appearance): void {
	writeStoredItem(APPEARANCE_KEY, JSON.stringify(appearance));
}
