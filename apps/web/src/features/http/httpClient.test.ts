import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePath, parseHeaderLines, prettyBody, sendHttp, type HttpDraft } from "./httpClient.js";

afterEach(() => vi.unstubAllGlobals());

const session = { sessionId: "s".repeat(32), authToken: "session-token" };

function fakeFetch(response: Response) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetcher = (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		return Promise.resolve(response);
	};
	return { fetcher, calls };
}

describe("httpClient", () => {
	it("normalizes what is typed into a path", () => {
		expect(normalizePath("items")).toBe("/items");
		expect(normalizePath(" /items?limit=5 ")).toBe("/items?limit=5");
		expect(normalizePath("http://localhost:3000/users/7?x=1")).toBe("/users/7?x=1");
	});

	it("reads header lines and skips what is not one", () => {
		expect(parseHeaderLines("Authorization: Bearer abc\n\nnot a header\nX-Id:7")).toEqual([
			["Authorization", "Bearer abc"],
			["X-Id", "7"],
		]);
	});

	it("re-indents JSON and leaves the rest alone", () => {
		expect(prettyBody('{"a":1}', "application/json")).toBe('{\n  "a": 1\n}');
		expect(prettyBody("plain", "text/plain")).toBe("plain");
		expect(prettyBody("{broken", "application/json")).toBe("{broken");
	});

	it("sends the program its own Authorization and Atomis's credentials apart", async () => {
		vi.stubGlobal("localStorage", { getItem: () => "atomis-token" });
		const { fetcher, calls } = fakeFetch(
			new Response('{"name":"Ada"}', { status: 201, headers: { "content-type": "application/json" } }),
		);
		const draft: HttpDraft = {
			method: "POST",
			path: "items",
			headers: "Authorization: Bearer user-jwt",
			body: '{"name":"Ada"}',
		};
		const exchange = await sendHttp(session, draft, 1, fetcher);
		const [call] = calls;
		expect(call?.url).toBe(`/api/sessions/${session.sessionId}/http/items`);
		const headers = new Headers(call?.init.headers);
		expect(headers.get("authorization")).toBe("Bearer user-jwt");
		expect(headers.get("x-atomis-session")).toBe("session-token");
		expect(headers.get("x-atomis-token")).toBe("atomis-token");
		expect(headers.get("content-type")).toBe("application/json");
		expect(call?.init.body).toBe('{"name":"Ada"}');
		expect(exchange).toMatchObject({ status: 201, body: '{\n  "name": "Ada"\n}', bytes: 14 });
	});

	it("never sends a body with GET", async () => {
		const { fetcher, calls } = fakeFetch(new Response("[]"));
		await sendHttp(session, { method: "GET", path: "/items", headers: "", body: "ignored" }, 1, fetcher);
		expect(calls[0]?.init.body).toBeUndefined();
	});

	it("tells Atomis's own failure from the program's answer", async () => {
		const proxied = fakeFetch(
			new Response('{"error":"Nothing is listening on port 21000."}', {
				status: 502,
				headers: { "x-atomis-proxy-error": "1" },
			}),
		);
		const failed = await sendHttp(session, { method: "GET", path: "/", headers: "", body: "" }, 1, proxied.fetcher);
		expect(failed.error).toBe("Nothing is listening on port 21000.");
		expect(failed.status).toBeUndefined();
		// The program's own 502 is just an answer.
		const own = fakeFetch(new Response("upstream down", { status: 502 }));
		const answered = await sendHttp(session, { method: "GET", path: "/", headers: "", body: "" }, 2, own.fetcher);
		expect(answered).toMatchObject({ status: 502, body: "upstream down" });
		expect(answered.error).toBeUndefined();
	});
});
