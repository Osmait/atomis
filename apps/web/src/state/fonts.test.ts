import { describe, expect, it } from "vitest";
import {
	APP_SIZES,
	DEFAULT_FONT,
	DEFAULT_SIZE,
	fontById,
	fontStack,
	isAppSize,
	MONO_FONTS,
} from "./fonts.js";

describe("font catalog", () => {
	it("offers a real choice of families and sizes", () => {
		expect(MONO_FONTS.length).toBeGreaterThanOrEqual(15);
		expect(APP_SIZES.length).toBeGreaterThanOrEqual(10);
		expect(isAppSize(DEFAULT_SIZE)).toBe(true);
	});

	it("keeps ids unique and stable-looking", () => {
		const ids = MONO_FONTS.map((font) => font.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(DEFAULT_FONT);
		// Ids are what preferences store, so they must not read as labels.
		for (const id of ids) expect(id, id).toMatch(/^[a-z0-9-]+$/);
	});

	it("always ends the stack in a generic fallback", () => {
		for (const font of MONO_FONTS)
			expect(fontStack(font.id), font.id).toMatch(/monospace$/);
	});

	it("quotes multi-word families and keeps single words bare", () => {
		expect(fontStack("jetbrains")).toBe(
			'"JetBrains Mono", ui-monospace, monospace',
		);
		expect(fontStack("hack")).toBe("Hack, ui-monospace, monospace");
		// An alias that is already the fallback is not repeated.
		expect(fontStack("sfmono")).toBe('"SF Mono", ui-monospace, monospace');
		expect(fontStack("system")).toBe("ui-monospace, monospace");
	});

	it("falls back to the default for an unknown id", () => {
		expect(fontById("comic-sans").id).toBe(DEFAULT_FONT);
		expect(fontStack("comic-sans")).toBe(fontStack(DEFAULT_FONT));
	});

	it("sorts sizes ascending so the row reads naturally", () => {
		expect([...APP_SIZES]).toEqual(APP_SIZES.toSorted((a, b) => a - b));
	});

	it("marks exactly the fonts that ship with the app as bundled", () => {
		const bundled = MONO_FONTS.filter((font) => font.bundled).map((f) => f.id);
		expect(bundled).toEqual(["jetbrains", "plex", "system"]);
	});
});
