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

import { apiFetch } from "../api/client.js";

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
/** Ceiling on the backoff between retries of a save that keeps failing. */
const MAX_RETRY_MS = 30_000;
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
let consecutiveFailures = 0;

function scheduleFlush(delay: number): void {
	if (flushTimer !== undefined) clearTimeout(flushTimer);
	flushTimer = setTimeout(() => void flush(), delay);
}

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

function removeLocal(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// storage unavailable; nothing to remove
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
	scheduleFlush(FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
	flushTimer = undefined;
	// A key another device moved past while ours sat queued (its newer value
	// arrived over the socket and is in `remote`) is stale here: retrying it
	// would overwrite their acknowledged value with our older one.
	for (const [key, value] of pending)
		if (remote !== null && remote.get(key) !== value) pending.delete(key);
	if (pending.size === 0) return;
	const sending = pending;
	pending = new Map();
	try {
		const response = await apiFetch(ENDPOINT, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ preferences: Object.fromEntries(sending) }),
		});
		if (!response.ok) throw new Error(String(response.status));
		consecutiveFailures = 0;
	} catch {
		// Put back only what nothing newer has replaced — locally by a later
		// write, or remotely by another device's value.
		for (const [key, value] of sending)
			if (!pending.has(key) && remote?.get(key) === value)
				pending.set(key, value);
		// And retry on our own: waiting for the next write would strand a
		// change made while the server was briefly unreachable, for as long
		// as nothing else happens to be changed.
		consecutiveFailures += 1;
		scheduleFlush(
			Math.min(FLUSH_DELAY_MS * 2 ** consecutiveFailures, MAX_RETRY_MS),
		);
	}
}

/**
 * Sends whatever is queued right now, in a request that outlives the page.
 *
 * The debounce is what makes a burst of toggles one save, but it also means
 * a setting changed immediately before a reload — "Load demo workspace" does
 * exactly that — was still waiting when the page went away, and the server's
 * older value came back on the next load.
 *
 * The queue is NOT emptied up front: this also runs on every
 * visibilitychange→hidden, where the page usually comes back, and a save the
 * server refused would have vanished in silence. Keys leave the queue only
 * once the response says they landed; a failure keeps them queued and
 * retries, exactly like the debounced path.
 */
export function flushPreferencesNow(): void {
	if (remote === null || pending.size === 0) return;
	const sending = new Map(pending);
	if (flushTimer !== undefined) clearTimeout(flushTimer);
	flushTimer = undefined;
	const retryLater = (): void => {
		consecutiveFailures += 1;
		scheduleFlush(
			Math.min(FLUSH_DELAY_MS * 2 ** consecutiveFailures, MAX_RETRY_MS),
		);
	};
	try {
		Promise.resolve(
			apiFetch(ENDPOINT, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ preferences: Object.fromEntries(sending) }),
				// The page is going; without this the request is cancelled with it.
				keepalive: true,
			}),
		).then(
			(response) => {
				if (!response.ok) {
					retryLater();
					return;
				}
				consecutiveFailures = 0;
				// Forget only what was actually delivered: a key rewritten
				// while the request flew keeps its newer value queued.
				for (const [key, value] of sending)
					if (pending.get(key) === value) pending.delete(key);
			},
			// The request died but the page may have survived (hidden and
			// shown again): everything is still queued, so retry on our own.
			// Handling the rejection here is also what keeps a genuinely
			// dying page from logging an unhandled rejection on the way out.
			retryLater,
		);
	} catch {
		// Leaving anyway; the value stays in localStorage for this device.
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
		const response = await apiFetch(ENDPOINT, { signal: controller.signal });
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
	listenForUnload();
}

/**
 * pagehide covers reload, navigation and the tab closing; visibilitychange
 * is what actually fires on iOS when Safari is backgrounded, which is the
 * same story on a tablet. Guarded because the loaders are unit-tested
 * without a DOM.
 */
function listenForUnload(): void {
	if (typeof window === "undefined") return;
	window.addEventListener("pagehide", flushPreferencesNow);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushPreferencesNow();
	});
}

/** Notified with the keys that a change from another device actually moved. */
type PreferencesListener = (changed: ReadonlySet<string>) => void;

const listeners = new Set<PreferencesListener>();

/** Subscribe to live changes. Returns the unsubscribe function. */
export function subscribeToPreferences(listener: PreferencesListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Applies a change another device made, arriving over the runtime socket.
 *
 * Deliberately does not queue an upload: the value came from the server, so
 * sending it back would bounce between devices forever. Keys whose value we
 * already hold are dropped, which is also what silently absorbs the echo of
 * our own write — so a device never re-renders because of its own change.
 */
export function applyRemotePreferences(
	incoming: Readonly<Record<string, string | null>>,
): void {
	if (remote === null) return;
	const changed = new Set<string>();
	for (const [key, value] of Object.entries(incoming)) {
		if (!SYNCED_KEYS.has(key)) continue;
		if ((remote.get(key) ?? null) === value) continue;
		if (value === null) {
			remote.delete(key);
			removeLocal(key);
		} else {
			remote.set(key, value);
			writeLocal(key, value);
		}
		changed.add(key);
	}
	if (changed.size === 0) return;
	for (const listener of listeners) listener(changed);
}

/** Test seam: forget the server's copy, queued writes and subscribers. */
export function resetPreferencesForTest(): void {
	remote = null;
	pending = new Map();
	if (flushTimer !== undefined) clearTimeout(flushTimer);
	flushTimer = undefined;
	consecutiveFailures = 0;
	listeners.clear();
}
