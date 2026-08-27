import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CHROME,
	loadChrome,
	saveChrome,
	tabsVisible,
} from "./chrome.js";

const KEY = "atomis.chrome.v1";

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
	const store = new Map(Object.entries(initial));
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	});
	return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("chrome settings", () => {
	it("shows every piece of furniture until told otherwise", () => {
		stubStorage();
		expect(loadChrome()).toEqual(DEFAULT_CHROME);
		expect(DEFAULT_CHROME).toEqual({
			toolbar: true,
			statusBar: true,
			hideSingleTab: false,
		});
	});

	it("round-trips what was saved", () => {
		stubStorage();
		saveChrome({ toolbar: false, statusBar: false, hideSingleTab: true });
		expect(loadChrome()).toEqual({
			toolbar: false,
			statusBar: false,
			hideSingleTab: true,
		});
	});

	it("keeps the defaults for anything stored wrong", () => {
		// A hand-edited or half-written value must not hide the toolbar with
		// no way back: only real booleans are honoured.
		stubStorage({ [KEY]: '{"toolbar":"no","statusBar":false}' });
		expect(loadChrome()).toEqual({
			toolbar: true,
			statusBar: false,
			hideSingleTab: false,
		});
		vi.unstubAllGlobals();
		stubStorage({ [KEY]: "not json at all" });
		expect(loadChrome()).toEqual(DEFAULT_CHROME);
	});

	it("hides the tabs for a lone file only when asked", () => {
		expect(tabsVisible(DEFAULT_CHROME, 1)).toBe(true);
		const on = { ...DEFAULT_CHROME, hideSingleTab: true };
		expect(tabsVisible(on, 1)).toBe(false);
		expect(tabsVisible(on, 2)).toBe(true);
		// No open file at all is the same lonely case.
		expect(tabsVisible(on, 0)).toBe(false);
	});
});
