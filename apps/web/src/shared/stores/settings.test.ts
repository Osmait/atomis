import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TEMPLATE_KEY,
	DEFAULT_LAYOUT,
	DEFAULT_SETTINGS,
	flushEntrySourceNow,
	loadDefaultTemplate,
	loadEntrySource,
	loadLayout,
	loadSettings,
	loadValueFmt,
	loadVimMode,
	saveDefaultTemplate,
	saveEntrySource,
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
		expect(loadDefaultTemplate()).toBe("zig");
	});

	it("fall back to defaults on corrupt JSON", () => {
		stubStorage({
			"atomis.settings.v1": "{no es json",
			"atomis.layout.v1": "[]corrupt",
		});
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
		expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
	});

	it("merge stored values over the defaults", () => {
		stubStorage({
			"atomis.settings.v1": JSON.stringify({ autoRun: false }),
			"atomis.layout.v1": JSON.stringify({ dock: "bottom" }),
			"atomis.value-fmt.v1": "hex",
			"atomis.vim-mode.v1": "false",
			"atomis.language.v1": "rust",
		});
		expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, autoRun: false });
		expect(loadLayout()).toEqual({ ...DEFAULT_LAYOUT, dock: "bottom" });
		expect(loadValueFmt()).toBe("hex");
		expect(loadVimMode()).toBe(false);
		expect(loadDefaultTemplate()).toBe("rust");
	});

	it("reject out-of-catalog appearance and language values", () => {
		stubStorage({
			"atomis.appearance.v1": JSON.stringify({
				// Was "dracula" until Dracula became a real theme.
				theme: "no-such-theme",
				fontIndex: 99,
				sizeIndex: -1,
				leader: "tab",
			}),
			"atomis.value-fmt.v1": "roman",
			"atomis.language.v1": "cobol",
		});
		expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
		expect(loadValueFmt()).toBe("dec");
		expect(loadDefaultTemplate()).toBe("zig");
	});

	it("persists the chosen default template", () => {
		const store = stubStorage();
		saveDefaultTemplate("go");
		expect(store.get(DEFAULT_TEMPLATE_KEY)).toBe("go");
		expect(loadDefaultTemplate()).toBe("go");
	});

	it("never persist manual probes", () => {
		const store = stubStorage();
		saveSettings({ ...DEFAULT_SETTINGS, manualProbeIds: ["p1", "p2"] });
		expect(
			JSON.parse(store.get("atomis.settings.v1") ?? "{}").manualProbeIds,
		).toEqual([]);
		stubStorage({
			"atomis.settings.v1": JSON.stringify({ manualProbeIds: ["p1"] }),
		});
		expect(loadSettings().manualProbeIds).toEqual([]);
	});

	it("clamps stored numeric settings into the server's ranges", () => {
		// A blob synced from another device with debounceMs 9999 used to make
		// the server refuse the whole settings.update on every connection.
		stubStorage({
			"atomis.settings.v1": JSON.stringify({
				debounceMs: 9999,
				timeoutMs: 50,
			}),
		});
		expect(loadSettings()).toMatchObject({ debounceMs: 500, timeoutMs: 100 });
		stubStorage({
			"atomis.settings.v1": JSON.stringify({
				debounceMs: 100,
				timeoutMs: 99_999,
			}),
		});
		expect(loadSettings()).toMatchObject({
			debounceMs: 300,
			timeoutMs: 10_000,
		});
	});

	it("discards stored settings fields of the wrong type", () => {
		stubStorage({
			"atomis.settings.v1": JSON.stringify({
				timeoutMs: "2000",
				debounceMs: null,
				autoRun: "yes",
				sandbox: 1,
			}),
		});
		expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps valid in-range values as they are", () => {
		stubStorage({
			"atomis.settings.v1": JSON.stringify({
				debounceMs: 350,
				timeoutMs: 5000,
				autoRun: false,
			}),
		});
		expect(loadSettings()).toMatchObject({
			debounceMs: 350,
			timeoutMs: 5000,
			autoRun: false,
		});
	});
});

describe("saveEntrySource", () => {
	it("debounces the localStorage write and reads its own pending value", () => {
		vi.useFakeTimers();
		try {
			const store = stubStorage();
			saveEntrySource("v1");
			saveEntrySource("v2");
			// Nothing hits storage until the typing pause…
			expect(store.has("atomis.source.v1")).toBe(false);
			// …but a reader already sees the newest value.
			expect(loadEntrySource()).toBe("v2");
			vi.advanceTimersByTime(500);
			expect(store.get("atomis.source.v1")).toBe("v2");
			expect(loadEntrySource()).toBe("v2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes immediately when asked (unload, tab hidden)", () => {
		vi.useFakeTimers();
		try {
			const store = stubStorage();
			saveEntrySource("last words");
			flushEntrySourceNow();
			expect(store.get("atomis.source.v1")).toBe("last words");
			// The debounce timer was cancelled: nothing writes twice.
			store.delete("atomis.source.v1");
			vi.advanceTimersByTime(1000);
			expect(store.has("atomis.source.v1")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
