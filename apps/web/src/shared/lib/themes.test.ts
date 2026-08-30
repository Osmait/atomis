import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	cssVariables,
	DEFAULT_THEME,
	isAppTheme,
	paletteOf,
	THEMES,
	THEME_IDS,
	type Palette,
} from "./themes.js";

const HEX = /^#[0-9a-f]{6}$/;

/** `#rrggbb` split into its three channel values. */
function channels(hex: string): number[] {
	return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

/** Every slot a palette must fill for the generated theme to be complete. */
const REQUIRED: (keyof Palette)[] = [
	"base",
	"mantle",
	"surface",
	"surface0",
	"surface1",
	"text",
	"subtext",
	"overlay",
	"overlayDim",
	"dim",
	"mauve",
	"red",
	"green",
	"yellow",
	"peach",
	"blue",
	"teal",
	"sky",
	"pink",
];

describe("theme catalog", () => {
	it("offers at least ten themes and a default that is one of them", () => {
		expect(THEME_IDS.length).toBeGreaterThanOrEqual(10);
		expect(THEME_IDS).toContain(DEFAULT_THEME);
	});

	it.each(THEME_IDS)("%s fills every palette slot with a hex colour", (id) => {
		const palette = paletteOf(id);
		for (const slot of REQUIRED) expect(String(palette[slot])).toMatch(HEX);
		expect(palette.label).not.toBe("");
		expect(["dark", "light"]).toContain(palette.scheme);
	});

	it("keeps theme ids and labels unique", () => {
		const labels = THEME_IDS.map((id) => THEMES[id].label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("only accepts ids it actually has", () => {
		expect(isAppTheme("mocha")).toBe(true);
		expect(isAppTheme("dracula")).toBe(true);
		expect(isAppTheme("no-such-theme")).toBe(false);
		expect(isAppTheme(undefined)).toBe(false);
	});
});

describe("generated custom properties", () => {
	it.each(THEME_IDS)("%s produces a value for every property", (id) => {
		for (const [name, value] of Object.entries(cssVariables(paletteOf(id)))) {
			expect(name.startsWith("--"), name).toBe(true);
			expect(value, name).toMatch(HEX);
		}
	});

	it("derives tints that sit between the accent and the theme's base", () => {
		const variables = cssVariables(paletteOf("mocha"));
		// A wash, not the accent itself, and not the flat background either.
		expect(variables["--mauve-dim"]).not.toBe(variables["--mauve"]);
		expect(variables["--mauve-dim"]).not.toBe(variables["--base"]);
		// Panels are the palette's own colours, exactly.
		expect(variables["--panel-editor"]).toBe("#1e1e2e");
		expect(variables["--panel-side"]).toBe("#181825");
	});

	/**
	 * The dimmed variants used to be hand-picked for Mocha. A linear blend
	 * does not reproduce them to the byte, so what is checked is that the
	 * generated ones land within a couple of steps per channel — close
	 * enough that the theme nobody chose to change did not change.
	 */
	it("reproduces the hand-picked Mocha tints it replaced", () => {
		const variables = cssVariables(paletteOf("mocha"));
		for (const [name, original] of [
			["--mauve-dim", "#2a2139"],
			["--mauve-border", "#4b3b63"],
			["--green-dim", "#4a5a4c"],
			["--surface0-dim", "#26263a"],
		] as const) {
			const generated = channels(String(variables[name]));
			channels(original).forEach((channel, index) => {
				expect(Math.abs((generated[index] ?? 0) - channel), name).toBeLessThanOrEqual(8);
			});
		}
	});

	it("gives a light theme the same properties, blended the other way", () => {
		const light = cssVariables(paletteOf("latte"));
		expect(Object.keys(light)).toEqual(
			Object.keys(cssVariables(paletteOf("mocha"))),
		);
		expect(paletteOf("latte").scheme).toBe("light");
	});

	/**
	 * The point of the palettes is that a theme is data, never CSS. If the
	 * stylesheet reads a property nothing defines, some theme renders wrong.
	 */
	it("defines every custom property the stylesheet reads", () => {
		const css = readFileSync(
			new URL("../../styles.css", import.meta.url),
			"utf8",
		);
		const generated = new Set(Object.keys(cssVariables(paletteOf("mocha"))));
		// Properties the stylesheet declares for itself (radii, shadows, fonts).
		const declared = new Set(
			[...css.matchAll(/^\t(--[\w-]+):/gm)].map((match) => match[1]),
		);
		// Only properties read without a fallback: `var(--row, 0)` is set from
		// a component's inline style and is deliberately optional here.
		const used = new Set(
			[...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]),
		);
		const undefinedVars = [...used].filter(
			(name) => !generated.has(String(name)) && !declared.has(name),
		);
		expect(undefinedVars).toEqual([]);
	});
});
