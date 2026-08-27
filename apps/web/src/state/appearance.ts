import { readStoredItem, writeStoredItem } from "./storage.js";

/**
 * Appearance preferences: theme, typography and the leader key. The option
 * catalogs live next to the persistence code so stored values can be
 * validated; the settings modal renders these same catalogs.
 */
export const APP_THEMES = [
	{ id: "mocha", label: "Mocha", dot: "#1e1e2e" },
	{ id: "macchiato", label: "Macchiato", dot: "#24273a" },
	{ id: "crust", label: "Crust", dot: "#11111b" },
] as const;

export type AppTheme = (typeof APP_THEMES)[number]["id"];

export const APP_FONTS = [
	{ label: "JetBrains Mono", css: '"JetBrains Mono", ui-monospace, monospace' },
	{ label: "IBM Plex Mono", css: '"IBM Plex Mono", ui-monospace, monospace' },
	{ label: "SF Mono", css: 'ui-monospace, "SF Mono", Menlo, monospace' },
] as const;

export const APP_SIZES = [12, 13, 14, 15] as const;

export const LEADER_OPTIONS = [
	{ id: "space", label: "Espacio" },
	{ id: "comma", label: "Coma ," },
	{ id: "backslash", label: "Barra \\" },
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
	theme: "mocha",
	fontIndex: 0,
	sizeIndex: 1,
	leader: "space",
};

const APPEARANCE_KEY = "ziglive.appearance.v1";

export function loadAppearance(): Appearance {
	try {
		const stored = JSON.parse(
			readStoredItem(APPEARANCE_KEY) ?? "{}",
		) as Partial<Appearance>;
		return {
			theme: APP_THEMES.some((entry) => entry.id === stored.theme)
				? (stored.theme as AppTheme)
				: "mocha",
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
