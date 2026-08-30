import type { JsonValue } from "@atomis/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWorkspace,
	deleteWorkspace,
	listWorkspaces,
	loadActiveWorkspace,
	saveActiveWorkspace,
} from "./workspaces.js";

function stubFetch(response: {
	ok: boolean;
	status?: number;
	body?: JsonValue;
}): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(() =>
		Promise.resolve({
			ok: response.ok,
			status: response.status ?? (response.ok ? 200 : 400),
			json: () => Promise.resolve(response.body ?? {}),
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("workspaces client", () => {
	it("lists and creates through the REST API", async () => {
		const meta = {
			id: "a".repeat(32),
			name: "AoC",
			language: "zig" as const,
			createdAt: 1,
			updatedAt: 2,
		};
		stubFetch({ ok: true, body: { workspaces: [meta] } });
		expect(await listWorkspaces()).toEqual([meta]);
		const fetchMock = stubFetch({ ok: true, body: { workspace: meta } });
		expect(
			await createWorkspace({
				name: "AoC",
				language: "zig",
				scaffold: "minimal",
			}),
		).toEqual(meta);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
	});

	it("surfaces the server's error message", async () => {
		stubFetch({ ok: false, status: 400, body: { error: "A workspace needs a name" } });
		await expect(
			createWorkspace({ name: " ", language: "zig", scaffold: "minimal" }),
		).rejects.toThrow("A workspace needs a name");
	});

	it("treats 204 as an empty response", async () => {
		stubFetch({ ok: true, status: 204 });
		await expect(deleteWorkspace("a".repeat(32))).resolves.toBeUndefined();
	});

	it("remembers the active workspace, and forgets it", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		});
		expect(loadActiveWorkspace()).toBeUndefined();
		saveActiveWorkspace("b".repeat(32));
		expect(loadActiveWorkspace()).toBe("b".repeat(32));
		saveActiveWorkspace(undefined);
		expect(loadActiveWorkspace()).toBeUndefined();
	});
});
