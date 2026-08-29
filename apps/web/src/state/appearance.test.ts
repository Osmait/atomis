import { describe, expect, it, vi } from "vitest";
import {
	type Appearance,
	DEFAULT_LEADER,
	isUsableLeader,
	leaderLabel,
	LEADER_OPTIONS,
	loadAppearance,
	normalizeLeader,
} from "./appearance.js";
import { DEFAULT_FONT, DEFAULT_SIZE } from "./fonts.js";

/** Runs the real loader over one stored blob, legacy fields included. */
function loadStored(stored: object): Appearance {
	vi.stubGlobal("localStorage", {
		getItem: (key: string) =>
			key === "atomis.appearance.v1" ? JSON.stringify(stored) : null,
		setItem: () => {},
	});
	return loadAppearance();
}

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

describe("typography", () => {
	it("migrates the stored index from when there were three fonts", () => {
		expect(loadStored({ fontIndex: 0 }).font).toBe("jetbrains");
		expect(loadStored({ fontIndex: 1 }).font).toBe("plex");
		expect(loadStored({ fontIndex: 2 }).font).toBe("sfmono");
		// Out of range, and the field the old build never wrote.
		expect(loadStored({ fontIndex: 99 }).font).toBe(DEFAULT_FONT);
		expect(loadStored({}).font).toBe(DEFAULT_FONT);
	});

	it("migrates the stored size index into real pixels", () => {
		expect(loadStored({ sizeIndex: 0 }).fontSize).toBe(12);
		expect(loadStored({ sizeIndex: 3 }).fontSize).toBe(15);
		expect(loadStored({ sizeIndex: -1 }).fontSize).toBe(DEFAULT_SIZE);
	});

	it("prefers the id and the pixel size once they are stored", () => {
		expect(loadStored({ font: "iosevka", fontIndex: 0 }).font).toBe("iosevka");
		expect(loadStored({ fontSize: 20, sizeIndex: 0 }).fontSize).toBe(20);
	});

	it("rejects a font id or size that is not in the catalog", () => {
		expect(loadStored({ font: "comic-sans" }).font).toBe(DEFAULT_FONT);
		expect(loadStored({ fontSize: 999 }).fontSize).toBe(DEFAULT_SIZE);
	});
});
