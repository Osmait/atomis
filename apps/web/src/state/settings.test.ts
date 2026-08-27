import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LAYOUT,
	DEFAULT_SETTINGS,
	loadLanguage,
	loadLayout,
	loadSettings,
	loadValueFmt,
	loadVimMode,
	saveSettings,
} from "./settings.js";
import { DEFAULT_APPEARANCE, loadAppearance } from "./appearance.js";

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
	const store = new Map(Object.entries(initial));
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	});
	return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("persistence loaders", () => {
	it("fall back to defaults without localStorage (node, privacy modes)", () => {
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
		expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
		expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
		expect(loadValueFmt()).toBe("dec");
		expect(loadVimMode()).toBe(true);
		expect(loadLanguage()).toBe("zig");
	});

	it("fall back to defaults on corrupt JSON", () => {
		stubStorage({
			"ziglive.settings.v1": "{no es json",
			"ziglive.layout.v1": "[]corrupt",
		});
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
		expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
	});

	it("merge stored values over the defaults", () => {
		stubStorage({
			"ziglive.settings.v1": JSON.stringify({ autoRun: false }),
			"ziglive.layout.v1": JSON.stringify({ dock: "bottom" }),
			"ziglive.value-fmt.v1": "hex",
			"ziglive.vim-mode.v1": "false",
			"ziglive.language.v1": "rust",
		});
		expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, autoRun: false });
		expect(loadLayout()).toEqual({ ...DEFAULT_LAYOUT, dock: "bottom" });
		expect(loadValueFmt()).toBe("hex");
		expect(loadVimMode()).toBe(false);
		expect(loadLanguage()).toBe("rust");
	});

	it("reject out-of-catalog appearance and language values", () => {
		stubStorage({
			"ziglive.appearance.v1": JSON.stringify({
				theme: "dracula",
				fontIndex: 99,
				sizeIndex: -1,
				leader: "tab",
			}),
			"ziglive.value-fmt.v1": "roman",
			"ziglive.language.v1": "cobol",
		});
		expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
		expect(loadValueFmt()).toBe("dec");
		expect(loadLanguage()).toBe("zig");
	});

	it("never persist manual probes", () => {
		const store = stubStorage();
		saveSettings({ ...DEFAULT_SETTINGS, manualProbeIds: ["p1", "p2"] });
		expect(
			JSON.parse(store.get("ziglive.settings.v1") ?? "{}").manualProbeIds,
		).toEqual([]);
		stubStorage({
			"ziglive.settings.v1": JSON.stringify({ manualProbeIds: ["p1"] }),
		});
		expect(loadSettings().manualProbeIds).toEqual([]);
	});
});
