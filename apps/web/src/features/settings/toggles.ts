import { saveInlineLogs } from "../../shared/stores/settings.js";
import type { Settings } from "../../shared/stores/settings.js";
import type { ChromeSettings } from "../../shared/stores/chrome.js";
import type { Toggle } from "./SettingsModal.js";

/** Everything the switches read or write. */
export interface SettingsTogglesDeps {
	settings: Settings;
	sendSettings: (next: Settings) => void;
	run: () => void;
	runDisabled: boolean;
	toggleAutoRun: () => void;
	inlineLogs: boolean;
	setInlineLogs: (update: (previous: boolean) => boolean) => void;
	chrome: ChromeSettings;
	updateChrome: (patch: Partial<ChromeSettings>) => void;
	vimEnabled: boolean;
	changeVimMode: (on: boolean) => void;
	zen: boolean;
	toggleZen: () => void;
	setSettingsOpen: (open: boolean) => void;
	sandboxAvailable: boolean;
	sandboxHint: string;
	networkHint: string;
}

/**
 * The behaviour switches, as data rather than as a hundred lines wedged
 * between the settings dialog's other props. A switch is a label, where it
 * belongs, whether it is on, and what flipping it does; the dialog decides
 * how to draw one.
 */
export function settingsToggles({
	settings,
	sendSettings,
	run,
	runDisabled,
	toggleAutoRun,
	inlineLogs,
	setInlineLogs,
	chrome,
	updateChrome,
	vimEnabled,
	changeVimMode,
	zen,
	toggleZen,
	setSettingsOpen,
	sandboxAvailable,
	sandboxHint,
	networkHint,
}: SettingsTogglesDeps): Toggle[] {
	return [
	{
		label: "Auto Run",
		group: "run",
		hint: "runs when you stop typing",
		on: settings.autoRun,
		disabled: runDisabled,
		act: toggleAutoRun,
	},
	{
		label: "Auto Inspect",
		group: "run",
		hint: "inline values",
		on: settings.autoInspect,
		act: () => {
			sendSettings({
				...settings,
				autoInspect: !settings.autoInspect,
			});
			setTimeout(run, 0);
		},
	},
	{
		label: "Inline logs",
		group: "editor",
		hint: "log output next to its line",
		on: inlineLogs,
		act: () => {
			setInlineLogs((previous) => {
				saveInlineLogs(!previous);
				return !previous;
			});
		},
	},
	{
		label: "Sandbox",
		group: "run",
		hint: sandboxHint,
		on: settings.sandbox,
		disabled: !sandboxAvailable,
		act: () =>
			sendSettings({
				...settings,
				sandbox: !settings.sandbox,
			}),
	},
	{
		label: "Allow network",
		group: "run",
		hint: networkHint,
		on: settings.network,
		disabled: !settings.sandbox && sandboxAvailable,
		act: () =>
			sendSettings({
				...settings,
				network: !settings.network,
			}),
	},
	{
		label: "Vim Mode",
		group: "editor",
		hint: "",
		on: vimEnabled,
		act: () => changeVimMode(!vimEnabled),
	},
	{
		label: "Toolbar",
		group: "appearance",
		hint: "tabs, auto, settings and Run",
		on: chrome.toolbar,
		act: () => updateChrome({ toolbar: !chrome.toolbar }),
	},
	{
		label: "Status bar",
		group: "appearance",
		hint: "mode, workspace and cursor along the bottom",
		on: chrome.statusBar,
		act: () => updateChrome({ statusBar: !chrome.statusBar }),
	},
	{
		label: "Hide tabs for one file",
		group: "appearance",
		hint: "the strip appears once a second file opens",
		on: chrome.hideSingleTab,
		disabled: !chrome.toolbar,
		act: () =>
			updateChrome({ hideSingleTab: !chrome.hideSingleTab }),
	},
	{
		label: "Zen Mode",
		group: "appearance",
		hint: "⌘.",
		on: zen,
		act: () => {
			setSettingsOpen(false);
			toggleZen();
		},
	},
	];
}
