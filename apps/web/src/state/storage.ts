/**
 * Preference storage, with the settings kept on the server.
 *
 * `localStorage` is per browser, so the same Atomis opened from a laptop and
 * from a tablet used to disagree with itself. The keys in SYNCED_KEYS are
 * held by the server instead; the rest stay local, because they describe the
 * device rather than the user's choices.
 *
 * Reads and writes stay synchronous — every loader runs during the first
 * render — so the remote store is fetched once before the app mounts and
 * mirrored in memory from then on. localStorage keeps a copy of everything:
 * it is the fallback when the server has no value yet, and the whole story
 * when the fetch fails.
 */

/** Settings that belong to you rather than to the machine you are on. */
const SYNCED_KEYS: ReadonlySet<string> = new Set([
	"atomis.settings.v1",
	"atomis.appearance.v1",
	"atomis.chrome.v1",
	"atomis.value-fmt.v1",
	"atomis.vim-mode.v1",
	"atomis.language.v1",
	"atomis.scaffold.v1",
	"atomis.inline-logs.v1",
]);

const ENDPOINT = "/api/preferences";
/** A settings toggle can fire several writes in a row; batch them. */
const FLUSH_DELAY_MS = 400;
/** Long enough for a slow tablet, short enough not to hang on a dead server. */
const HYDRATE_TIMEOUT_MS = 5000;

/**
 * The server's copy, or null while it is unknown — a failed or timed-out
 * hydration leaves it null, which disables uploads entirely. Falling back to
 * local-only is the safe failure: it cannot overwrite good settings on the
 * server with the defaults this device would otherwise render.
 */
let remote: Map<string, string> | null = null;
let pending = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function readLocal(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeLocal(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable; the preference simply won't persist locally
	}
}

export function readStoredItem(key: string): string | null {
	const shared = remote?.get(key);
	return shared ?? readLocal(key);
}

export function writeStoredItem(key: string, value: string): void {
	writeLocal(key, value);
	if (remote === null || !SYNCED_KEYS.has(key)) return;
	remote.set(key, value);
	pending.set(key, value);
	if (flushTimer !== undefined) clearTimeout(flushTimer);
	flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
	flushTimer = undefined;
	if (pending.size === 0) return;
	const sending = pending;
	pending = new Map();
	try {
		const response = await fetch(ENDPOINT, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ preferences: Object.fromEntries(sending) }),
		});
		if (!response.ok) throw new Error(String(response.status));
	} catch {
		// Put back only what nothing newer has replaced, so the next write
		// carries this one along instead of losing it.
		for (const [key, value] of sending)
			if (!pending.has(key)) pending.set(key, value);
	}
}

/**
 * Loads the server's settings before the app renders. Any synced key this
 * browser has but the server does not is sent up, which is what carries the
 * settings you already had into the shared store the first time.
 */
export async function hydratePreferences(): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HYDRATE_TIMEOUT_MS);
	try {
		const response = await fetch(ENDPOINT, { signal: controller.signal });
		if (!response.ok) return;
		const body = (await response.json()) as {
			preferences?: Record<string, string>;
		};
		remote = new Map(Object.entries(body.preferences ?? {}));
		for (const key of SYNCED_KEYS) {
			if (remote.has(key)) continue;
			const local = readLocal(key);
			if (local === null) continue;
			remote.set(key, local);
			pending.set(key, local);
		}
		if (pending.size > 0) await flush();
	} catch {
		// Offline, or no server: stay on localStorage and never upload.
	} finally {
		clearTimeout(timeout);
	}
}

/** Test seam: forget the server's copy and any queued write. */
export function resetPreferencesForTest(): void {
	remote = null;
	pending = new Map();
	if (flushTimer !== undefined) clearTimeout(flushTimer);
	flushTimer = undefined;
}
