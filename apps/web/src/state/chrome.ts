import { readStoredItem, writeStoredItem } from "./storage.js";

/**
 * How much of the window's furniture is drawn: the toolbar above the
 * editor, the status bar below it, and whether buffer tabs appear while a
 * single file is open. Everything here can be turned off, so the settings
 * dialog is also reachable from the command palette — hiding the toolbar
 * takes the gear with it.
 */
export interface ChromeSettings {
	/** Draw the toolbar row: tabs, auto-run, settings and Run. */
	toolbar: boolean;
	/** Draw the status bar along the bottom. */
	statusBar: boolean;
	/** Keep the tabs out of the way until a second file is open. */
	hideSingleTab: boolean;
}

export const DEFAULT_CHROME: ChromeSettings = {
	toolbar: true,
	statusBar: true,
	hideSingleTab: false,
};

const CHROME_KEY = "atomis.chrome.v1";

/** Anything stored that is not a real boolean falls back to the default. */
function readFlag(value: boolean | undefined, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function loadChrome(): ChromeSettings {
	try {
		const stored = JSON.parse(
			readStoredItem(CHROME_KEY) ?? "{}",
		) as Partial<ChromeSettings>;
		return {
			toolbar: readFlag(stored.toolbar, DEFAULT_CHROME.toolbar),
			statusBar: readFlag(stored.statusBar, DEFAULT_CHROME.statusBar),
			hideSingleTab: readFlag(
				stored.hideSingleTab,
				DEFAULT_CHROME.hideSingleTab,
			),
		};
	} catch {
		return DEFAULT_CHROME;
	}
}

export function saveChrome(chrome: ChromeSettings): void {
	writeStoredItem(CHROME_KEY, JSON.stringify(chrome));
}

/** Whether the buffer tabs should be drawn for this many open files. */
export function tabsVisible(chrome: ChromeSettings, openTabs: number): boolean {
	return !chrome.hideSingleTab || openTabs > 1;
}
