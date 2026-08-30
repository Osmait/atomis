import { describe, expect, it } from "vitest";
import { closeTab, cycleTab } from "./tabs.js";

describe("cycleTab", () => {
	const tabs = ["main.zig", "util.zig", "aoc.rs"];
	it("moves forward and wraps", () => {
		expect(cycleTab(tabs, "main.zig", 1)).toBe("util.zig");
		expect(cycleTab(tabs, "aoc.rs", 1)).toBe("main.zig");
	});
	it("moves backward and wraps", () => {
		expect(cycleTab(tabs, "util.zig", -1)).toBe("main.zig");
		expect(cycleTab(tabs, "main.zig", -1)).toBe("aoc.rs");
	});
	it("does nothing with a single tab", () =>
		expect(cycleTab(["main.zig"], "main.zig", 1)).toBeUndefined());
});

describe("closeTab", () => {
	it("keeps the active file when closing another tab", () =>
		expect(closeTab(["a", "b", "c"], "b", "a", "main.zig")).toEqual({
			tabs: ["a", "c"],
		}));
	it("activates the last remaining tab when closing the active one", () =>
		expect(closeTab(["a", "b", "c"], "c", "c", "main.zig")).toEqual({
			tabs: ["a", "b"],
			nextActive: "b",
		}));
	it("falls back to the entry file when the last tab closes", () =>
		expect(closeTab(["a"], "a", "a", "main.zig")).toEqual({
			tabs: ["main.zig"],
			nextActive: "main.zig",
		}));
});
