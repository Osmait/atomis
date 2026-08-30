import type { ProbeValueEvent } from "@atomis/protocol";
import { describe, expect, it } from "vitest";
import {
	acceptsVersion,
	toggleProbe,
	updateInlineValue,
} from "./runtimeState.js";

const eventFor = (runId: string, preview: string): ProbeValueEvent => ({
	protocolVersion: 1,
	type: "probe_value",
	kind: "probe_value",
	sessionId: "s",
	runId,
	documentVersion: 1,
	probeId: "p",
	name: "x",
	line: 1,
	column: 1,
	typeName: "i32",
	preview,
	truncated: false,
	sequence: 1,
	timestamp: 1,
	count: 1,
});

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
	it("starts a fresh history when a new run reports the probe", () => {
		let values = updateInlineValue(new Map(), eventFor("run-1", "40"));
		values = updateInlineValue(values, eventFor("run-1", "41"));
		expect(values.get("p")?.history).toEqual(["40", "41"]);
		// Re-running unchanged code must not pile up identical entries.
		values = updateInlineValue(values, eventFor("run-2", "41"));
		expect(values.get("p")?.history).toEqual(["41"]);
	});

	it("toggles a manual probe", () => {
		expect(toggleProbe([], "p")).toEqual(["p"]);
		expect(toggleProbe(["p"], "p")).toEqual([]);
	});
});
