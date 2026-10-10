import { describe, expect, it } from "vitest";
import { WEB_LANGUAGE_PACKS } from "../editor/languagePacks.js";
import { DEMO_KINDS, demosOf } from "./catalog.js";

describe("demo catalog", () => {
	it("opens each demo on its language's entry file, with real source", () => {
		for (const kind of DEMO_KINDS)
			for (const demo of demosOf(kind)) {
				expect(demo.files).toHaveLength(1);
				expect(demo.files[0]?.path).toBe(WEB_LANGUAGE_PACKS[demo.language].entryFile);
				expect(demo.files[0]?.source.length).toBeGreaterThan(100);
			}
	});

	it("has the calculator REPL in all seven languages, reading typed input", () => {
		const repl = DEMO_KINDS.find((kind) => kind.id === "repl");
		expect(repl?.stdinMode).toBe("terminal");
		expect(demosOf(repl!).map((demo) => demo.language)).toEqual(
			Object.keys(WEB_LANGUAGE_PACKS),
		);
	});

	it("has the mini Redis in all seven languages", () => {
		const redis = DEMO_KINDS.find((kind) => kind.id === "redis");
		expect(demosOf(redis!).map((demo) => demo.language)).toEqual(
			Object.keys(WEB_LANGUAGE_PACKS),
		);
	});

	it("has the REST API in all seven languages and on four frameworks, opening as servers", () => {
		const rest = DEMO_KINDS.find((kind) => kind.id === "rest");
		expect(rest?.serve).toBe(true);
		expect(demosOf(rest!)).toHaveLength(7);
		const framework = DEMO_KINDS.find((kind) => kind.id === "rest-framework");
		const demos = demosOf(framework!);
		expect(demos.map((demo) => `${demo.language}:${demo.variant}`)).toEqual([
			"rust:axum",
			"go:gin",
			"ts:Express",
			"py:FastAPI",
		]);
		// Every framework demo installs what it imports.
		for (const demo of demos) expect(demo.dependencies.length).toBeGreaterThan(0);
	});

	it("gives every demo a unique id", () => {
		const ids = DEMO_KINDS.flatMap((kind) => demosOf(kind).map((demo) => demo.id));
		expect(new Set(ids).size).toBe(ids.length);
	});
});
