/**
 * localStorage access that tolerates missing or blocked storage (tests,
 * privacy modes): reads fall back to null, writes are dropped silently.
 */
export function readStoredItem(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeStoredItem(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable; the preference simply won't persist
	}
}
