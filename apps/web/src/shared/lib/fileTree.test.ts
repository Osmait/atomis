import { describe, expect, it } from "vitest";
import { buildTreeRows } from "./fileTree.js";

describe("buildTreeRows", () => {
	it("groups files under implicit folders, folders first", () => {
		const rows = buildTreeRows({
			files: ["main.zig", "utils/helper.zig", "utils/deep/x.zig", "aoc.rs"],
			collapsed: new Set(),
			pendingFolders: [],
			failsByFile: new Map(),
		});
		expect(
			rows.map((row) => [row.kind, row.path, row.depth]),
		).toEqual([
			["folder", "utils", 0],
			["folder", "utils/deep", 1],
			["file", "utils/deep/x.zig", 2],
			["file", "utils/helper.zig", 1],
			["file", "aoc.rs", 0],
			["file", "main.zig", 0],
		]);
		expect(rows[0]).toMatchObject({ name: "utils", pending: false });
	});

	it("hides the children of collapsed folders", () => {
		const rows = buildTreeRows({
			files: ["main.zig", "utils/helper.zig", "utils/deep/x.zig"],
			collapsed: new Set(["utils"]),
			pendingFolders: [],
			failsByFile: new Map(),
		});
		expect(rows.map((row) => row.path)).toEqual(["utils", "main.zig"]);
		expect(rows[0]).toMatchObject({ kind: "folder", collapsed: true });
	});

	it("aggregates failing-test counts up the folder chain", () => {
		const rows = buildTreeRows({
			files: ["a/b/one.zig", "a/two.zig"],
			collapsed: new Set(),
			pendingFolders: [],
			failsByFile: new Map([
				["a/b/one.zig", 2],
				["a/two.zig", 1],
			]),
		});
		const folders = rows.filter((row) => row.kind === "folder");
		expect(folders.map((row) => [row.path, row.fails])).toEqual([
			["a", 3],
			["a/b", 2],
		]);
	});

	it("shows pending folders until a real file lands inside", () => {
		const pending = buildTreeRows({
			files: ["main.zig"],
			collapsed: new Set(),
			pendingFolders: ["aoc/day1"],
			failsByFile: new Map(),
		});
		expect(
			pending
				.filter((row) => row.kind === "folder")
				.map((row) => [row.path, row.pending]),
		).toEqual([
			["aoc", true],
			["aoc/day1", true],
		]);
		const materialized = buildTreeRows({
			files: ["main.zig", "aoc/day1/input.txt"],
			collapsed: new Set(),
			pendingFolders: ["aoc/day1"],
			failsByFile: new Map(),
		});
		expect(
			materialized
				.filter((row) => row.kind === "folder")
				.every((row) => !row.pending),
		).toBe(true);
	});
});
