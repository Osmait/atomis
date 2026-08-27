/**
 * Open-tab bookkeeping for the editor's tab pill: cycling with Shift+H/L
 * and closing a tab while keeping a sensible active file.
 */
export function cycleTab(
	tabs: readonly string[],
	active: string,
	direction: 1 | -1,
): string | undefined {
	if (tabs.length < 2) return undefined;
	const index = tabs.indexOf(active);
	const nextIndex =
		direction === 1
			? (index + 1) % tabs.length
			: (index - 1 + tabs.length) % tabs.length;
	return tabs[nextIndex];
}

export interface CloseTabResult {
	tabs: string[];
	/** File to activate, present only when the closed tab was the active one. */
	nextActive?: string;
}

export function closeTab(
	tabs: readonly string[],
	closing: string,
	active: string,
	entryFile: string,
): CloseTabResult {
	const remaining = tabs.filter((tab) => tab !== closing);
	const next = remaining.length ? remaining : [entryFile];
	if (active !== closing) return { tabs: next };
	return { tabs: next, nextActive: next[next.length - 1] ?? entryFile };
}
