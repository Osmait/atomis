import { readStoredItem, writeStoredItem } from "./storage.js";
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

export const APP_FONTS = [
	{ label: "JetBrains Mono", css: '"JetBrains Mono", ui-monospace, monospace' },
	{ label: "IBM Plex Mono", css: '"IBM Plex Mono", ui-monospace, monospace' },
	{ label: "SF Mono", css: 'ui-monospace, "SF Mono", Menlo, monospace' },
] as const;

export const APP_SIZES = [12, 13, 14, 15] as const;

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
	fontIndex: number;
	sizeIndex: number;
	leader: LeaderKey;
}

export const DEFAULT_APPEARANCE: Appearance = {
	theme: DEFAULT_THEME,
	fontIndex: 0,
	sizeIndex: 1,
	leader: DEFAULT_LEADER,
};

export const APPEARANCE_KEY = "atomis.appearance.v1";

export function loadAppearance(): Appearance {
	try {
		const stored = JSON.parse(
			readStoredItem(APPEARANCE_KEY) ?? "{}",
		) as Partial<Appearance>;
		return {
			theme: isAppTheme(stored.theme) ? stored.theme : DEFAULT_THEME,
			fontIndex:
				typeof stored.fontIndex === "number" &&
				stored.fontIndex >= 0 &&
				stored.fontIndex < APP_FONTS.length
					? stored.fontIndex
					: 0,
			sizeIndex:
				typeof stored.sizeIndex === "number" &&
				stored.sizeIndex >= 0 &&
				stored.sizeIndex < APP_SIZES.length
					? stored.sizeIndex
					: 1,
			leader: normalizeLeader(stored.leader),
		};
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

export function saveAppearance(appearance: Appearance): void {
	writeStoredItem(APPEARANCE_KEY, JSON.stringify(appearance));
}
