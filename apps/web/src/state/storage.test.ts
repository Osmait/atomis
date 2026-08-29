import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	hydratePreferences,
	readStoredItem,
	resetPreferencesForTest,
	writeStoredItem,
} from "./storage.js";

const THEME = "atomis.appearance.v1";
const LAYOUT = "atomis.layout.v1";

let local: Map<string, string>;

function stubFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
	vi.stubGlobal("fetch", vi.fn(handler));
}

function json(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	resetPreferencesForTest();
	local = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => local.get(key) ?? null,
		setItem: (key: string, value: string) => local.set(key, value),
	});
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("preferences shared across devices", () => {
	it("prefers the server's value over this browser's", async () => {
		local.set(THEME, '{"theme":"crust"}');
		stubFetch(() => json({ preferences: { [THEME]: '{"theme":"mocha"}' } }));
		await hydratePreferences();
		expect(readStoredItem(THEME)).toBe('{"theme":"mocha"}');
	});

	it("uploads what this browser already had when the server has nothing", async () => {
		local.set(THEME, '{"theme":"crust"}');
		const calls: RequestInit[] = [];
		stubFetch((_url, init) => {
			if (init?.method === "PUT") calls.push(init);
			return json({ preferences: {} });
		});
		await hydratePreferences();
		expect(calls).toHaveLength(1);
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			preferences: { [THEME]: '{"theme":"crust"}' },
		});
	});

	it("sends only synced keys, and batches a burst into one request", async () => {
		let puts = 0;
		let sent: Record<string, string> = {};
		stubFetch((_url, init) => {
			if (init?.method === "PUT") {
				puts += 1;
				sent = (
					JSON.parse(String(init.body)) as {
						preferences: Record<string, string>;
					}
				).preferences;
			}
			return json({ preferences: {} });
		});
		await hydratePreferences();

		writeStoredItem(LAYOUT, '{"dock":"bottom"}');
		writeStoredItem(THEME, '{"theme":"a"}');
		writeStoredItem(THEME, '{"theme":"b"}');
		await vi.runAllTimersAsync();

		expect(puts).toBe(1);
		expect(sent).toEqual({ [THEME]: '{"theme":"b"}' });
		// The device-local key still persists, just not to the server.
		expect(readStoredItem(LAYOUT)).toBe('{"dock":"bottom"}');
	});

	it("falls back to local storage when the server cannot be reached", async () => {
		local.set(THEME, '{"theme":"crust"}');
		stubFetch(() => Promise.reject(new Error("offline")));
		await hydratePreferences();
		expect(readStoredItem(THEME)).toBe('{"theme":"crust"}');
	});

	it("never uploads after a failed hydration, so defaults cannot overwrite the server", async () => {
		let puts = 0;
		stubFetch((_url, init) => {
			if (init?.method === "PUT") puts += 1;
			return Promise.reject(new Error("offline"));
		});
		await hydratePreferences();
		writeStoredItem(THEME, '{"theme":"mocha"}');
		await vi.runAllTimersAsync();
		expect(puts).toBe(0);
		expect(readStoredItem(THEME)).toBe('{"theme":"mocha"}');
	});

	it("keeps a rejected write queued so the next one carries it", async () => {
		let failNext = true;
		const bodies: string[] = [];
		stubFetch((_url, init) => {
			if (init?.method !== "PUT") return json({ preferences: {} });
			bodies.push(String(init.body));
			if (failNext) {
				failNext = false;
				return json({ error: "nope" }, 500);
			}
			return json({ preferences: {} });
		});
		await hydratePreferences();

		writeStoredItem(THEME, '{"theme":"a"}');
		await vi.runAllTimersAsync();
		writeStoredItem("atomis.vim-mode.v1", "false");
		await vi.runAllTimersAsync();

		expect(bodies).toHaveLength(2);
		expect(JSON.parse(String(bodies[1])).preferences).toEqual({
			[THEME]: '{"theme":"a"}',
			"atomis.vim-mode.v1": "false",
		});
	});
});
