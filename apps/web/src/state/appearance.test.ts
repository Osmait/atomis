import { describe, expect, it } from "vitest";
import {
	DEFAULT_LEADER,
	isUsableLeader,
	leaderLabel,
	LEADER_OPTIONS,
	normalizeLeader,
} from "./appearance.js";

describe("leader key", () => {
	it("takes any ordinary key, not just the presets", () => {
		for (const key of ["b", ";", "º", "ñ", "F5", "ArrowUp", "Tab", "Enter"])
			expect(normalizeLeader(key), key).toBe(key);
	});

	it("migrates the option ids stored before any key was allowed", () => {
		expect(normalizeLeader("space")).toBe(" ");
		expect(normalizeLeader("comma")).toBe(",");
		expect(normalizeLeader("backslash")).toBe("\\");
	});

	/**
	 * A modifier alone never reaches the navigation core, and Escape is what
	 * cancels the capture — accepting either would leave a leader that can
	 * never fire, or a recording that cannot be backed out of.
	 */
	it("refuses keys that could never work as a leader", () => {
		// Modifiers and Escape are excluded by rule; the rest are strings no
		// key event ever produces, and would be a leader that never fires.
		for (const key of [
			"Shift",
			"Control",
			"Alt",
			"Meta",
			"Escape",
			"",
			"tab",
			"cobol",
			"F0",
			"F25",
		]) {
			expect(isUsableLeader(key), key).toBe(false);
			expect(normalizeLeader(key), key).toBe(DEFAULT_LEADER);
		}
	});

	it("falls back when nothing is stored", () => {
		expect(normalizeLeader(undefined)).toBe(DEFAULT_LEADER);
	});

	it("names the one key whose own value is unreadable", () => {
		expect(leaderLabel(" ")).toBe("Space");
		expect(leaderLabel(",")).toBe(",");
		expect(leaderLabel("ArrowUp")).toBe("ArrowUp");
	});

	it("keeps every preset usable and distinct", () => {
		const keys = LEADER_OPTIONS.map((option) => option.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const key of keys) expect(isUsableLeader(key), key).toBe(true);
	});
});
