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

export const LEADER_OPTIONS = [
	{ id: "space", label: "Space" },
	{ id: "comma", label: "Comma ," },
	{ id: "backslash", label: "Backslash \\" },
] as const;

export type LeaderKey = (typeof LEADER_OPTIONS)[number]["id"];

/** Leader option id → the actual `KeyboardEvent.key` it matches. */
export const LEADER_KEYS: Record<LeaderKey, string> = {
	space: " ",
	comma: ",",
	backslash: "\\",
};

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
	leader: "space",
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
			leader:
				stored.leader && stored.leader in LEADER_KEYS
					? stored.leader
					: "space",
		};
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

export function saveAppearance(appearance: Appearance): void {
	writeStoredItem(APPEARANCE_KEY, JSON.stringify(appearance));
}
