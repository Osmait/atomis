import { describe, expect, it } from "vitest";
import {
	acceptsVersion,
	toggleProbe,
	updateInlineValue,
} from "./runtimeState.js";

describe("runtime state", () => {
	it("rejects stale versions", () => expect(acceptsVersion(3, 2)).toBe(false));
	it("retains only twenty probe previews", () => {
		let values = new Map();
		for (let index = 1; index <= 25; index++)
			values = updateInlineValue(values, {
				protocolVersion: 1,
				type: "probe_value",
				kind: "probe_value",
				sessionId: "s",
				runId: "r",
				documentVersion: 1,
				probeId: "p",
				name: "x",
				line: 1,
				column: 1,
				typeName: "i32",
				preview: String(index),
				truncated: false,
				sequence: index,
				timestamp: index,
				count: index,
			});
		expect(values.get("p")?.history).toHaveLength(20);
		expect(values.get("p")?.history[0]).toBe("6");
	});
	it("toggles a manual probe", () => {
		expect(toggleProbe([], "p")).toEqual(["p"]);
		expect(toggleProbe(["p"], "p")).toEqual([]);
	});
});
