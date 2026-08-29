/**
 * Monospace families offered in Settings → Appearance.
 *
 * Two are bundled with the app and always work. The rest are whatever the
 * device already has, which is free to offer and costs nothing to ship —
 * but means the list is only honest if it says which ones are actually
 * installed here.
 */

export interface MonoFont {
	/** Stored in preferences, so it must never change for a given font. */
	id: string;
	label: string;
	/** The family name, as the system knows it. */
	family: string;
	/** Shipped with the app: present regardless of the device. */
	bundled?: boolean;
	/** Extra families to try before the generic fallback. */
	aliases?: string[];
}

export const MONO_FONTS: MonoFont[] = [
	{
		id: "jetbrains",
		label: "JetBrains Mono",
		family: "JetBrains Mono",
		bundled: true,
	},
	{ id: "plex", label: "IBM Plex Mono", family: "IBM Plex Mono", bundled: true },
	{ id: "sfmono", label: "SF Mono", family: "SF Mono", aliases: ["ui-monospace"] },
	{ id: "menlo", label: "Menlo", family: "Menlo" },
	{ id: "monaco", label: "Monaco", family: "Monaco" },
	{ id: "cascadia", label: "Cascadia Code", family: "Cascadia Code" },
	{ id: "consolas", label: "Consolas", family: "Consolas" },
	{ id: "fira-code", label: "Fira Code", family: "Fira Code" },
	{ id: "fira-mono", label: "Fira Mono", family: "Fira Mono" },
	{ id: "source-code", label: "Source Code Pro", family: "Source Code Pro" },
	{ id: "hack", label: "Hack", family: "Hack" },
	{ id: "inconsolata", label: "Inconsolata", family: "Inconsolata" },
	{ id: "iosevka", label: "Iosevka", family: "Iosevka" },
	{ id: "roboto-mono", label: "Roboto Mono", family: "Roboto Mono" },
	{ id: "noto-mono", label: "Noto Sans Mono", family: "Noto Sans Mono" },
	{ id: "ubuntu-mono", label: "Ubuntu Mono", family: "Ubuntu Mono" },
	{ id: "dejavu", label: "DejaVu Sans Mono", family: "DejaVu Sans Mono" },
	{ id: "liberation", label: "Liberation Mono", family: "Liberation Mono" },
	{ id: "maple", label: "Maple Mono", family: "Maple Mono" },
	{ id: "adwaita", label: "Adwaita Mono", family: "Adwaita Mono" },
	{ id: "cousine", label: "Cousine", family: "Cousine" },
	{ id: "courier", label: "Courier New", family: "Courier New" },
	{ id: "system", label: "System mono", family: "ui-monospace", bundled: true },
];

export const DEFAULT_FONT = "jetbrains";

/** Editor and UI type sizes, in px. */
export const APP_SIZES = [
	10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24,
] as const;

export const DEFAULT_SIZE = 13;

export function fontById(id: string): MonoFont {
	return (
		MONO_FONTS.find((font) => font.id === id) ??
		(MONO_FONTS.find((font) => font.id === DEFAULT_FONT) as MonoFont)
	);
}

/**
 * The CSS `font-family` value, always ending in a generic fallback. Names
 * are deduplicated: a font whose family already is `ui-monospace` would
 * otherwise repeat it when the tail is appended.
 */
export function fontStack(id: string): string {
	const font = fontById(id);
	const names = [
		...new Set([
			font.family,
			...(font.aliases ?? []),
			"ui-monospace",
			"monospace",
		]),
	];
	return names
		.map((name) => (name.includes(" ") ? `"${name}"` : name))
		.join(", ");
}

export function isAppSize(value: number): boolean {
	return (APP_SIZES as readonly number[]).includes(value);
}

/**
 * Which families the device can actually render.
 *
 * `document.fonts.check()` cannot answer this — it returns true for a name
 * nothing has ever heard of, because the fallback would still render. So
 * measure instead: a family that changes the width of a sample against
 * every generic fallback is one the device really has. Bundled faces skip
 * the test, since a webfont the page has not used yet measures as missing.
 */
export function detectAvailableFonts(): Set<string> {
	const available = new Set(
		MONO_FONTS.filter((font) => font.bundled).map((font) => font.id),
	);
	const context = document.createElement("canvas").getContext("2d");
	if (!context) {
		// No canvas (rare, or a hardened browser): claim nothing is missing
		// rather than greying out every choice.
		return new Set(MONO_FONTS.map((font) => font.id));
	}
	const SAMPLE = "mmmMMMwwwiiil10O@#";
	const GENERICS = ["monospace", "serif", "sans-serif"];
	const widthOf = (family: string): number => {
		context.font = `72px ${family}`;
		return context.measureText(SAMPLE).width;
	};
	const baseline = GENERICS.map((generic) => widthOf(generic));
	for (const font of MONO_FONTS) {
		if (available.has(font.id)) continue;
		const changed = GENERICS.some(
			(generic, index) =>
				widthOf(`"${font.family}", ${generic}`) !== baseline[index],
		);
		if (changed) available.add(font.id);
	}
	return available;
}
