import { describe, expect, it } from "vitest";
import {
	isValidProjectPath,
	normalizeFolderName,
	websocketUrl,
} from "./paths.js";

describe("isValidProjectPath", () => {
	it("accepts nested relative paths", () => {
		expect(isValidProjectPath("main.zig")).toBe(true);
		expect(isValidProjectPath("utils/deep/helper.zig")).toBe(true);
	});
	it("rejects traversal, absolutes and backslashes", () => {
		expect(isValidProjectPath("")).toBe(false);
		expect(isValidProjectPath("/etc/passwd")).toBe(false);
		expect(isValidProjectPath("a\\b.zig")).toBe(false);
		expect(isValidProjectPath("../x.zig")).toBe(false);
		expect(isValidProjectPath("a//b.zig")).toBe(false);
		expect(isValidProjectPath("a/./b.zig")).toBe(false);
	});
});

describe("normalizeFolderName", () => {
	it("strips trailing slashes only", () => {
		expect(normalizeFolderName("utils///")).toBe("utils");
		expect(normalizeFolderName("a/b")).toBe("a/b");
	});
});

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
				"https://ziglive.dev/",
			),
		);
		expect(url.protocol).toBe("wss:");
		expect(url.searchParams.get("lang")).toBe("rust");
	});
});
