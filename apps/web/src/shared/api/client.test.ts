import { describe, expect, it } from "vitest";
import { websocketUrl } from "./client.js";

describe("websocketUrl", () => {
	const session = { sessionId: "s1", authToken: "t1" };
	it("switches to ws and carries the credentials", () => {
		const url = new URL(
			websocketUrl("/ws/runtime", session, {}, "http://127.0.0.1:5173/"),
		);
		expect(url.protocol).toBe("ws:");
		expect(url.pathname).toBe("/ws/runtime");
		expect(url.searchParams.get("sessionId")).toBe("s1");
		expect(url.searchParams.get("token")).toBe("t1");
	});
	it("uses wss on https pages and appends extra params", () => {
		const url = new URL(
			websocketUrl(
				"/ws/lsp",
				session,
				{ lang: "rust" },
				"https://atomis.dev/",
			),
		);
		expect(url.protocol).toBe("wss:");
		expect(url.searchParams.get("lang")).toBe("rust");
	});
});
