import { describe, expect, it } from "vitest";
import { discoverTests, matchRunnerName } from "./TestDiscovery.js";
import { TestEventReader, type RawTestEvent } from "./TestEventReader.js";

describe("discoverTests", () => {
	it("finds string and decl tests with 1-based positions", () => {
		const tests = discoverTests([
			{
				path: "two-sum.zig",
				source:
					'const std = @import("std");\n\ntest "ejemplo del enunciado" {\n}\n\n  test "duplicados" {\n}\ntest twoSum {\n}\n',
			},
			{ path: "input.txt", source: 'test "no es zig" {\n' },
		]);
		expect(tests).toEqual([
			{
				testId: "two-sum.zig:3",
				path: "src/two-sum.zig",
				name: "ejemplo del enunciado",
				line: 3,
				column: 1,
			},
			{
				testId: "two-sum.zig:6",
				path: "src/two-sum.zig",
				name: "duplicados",
				line: 6,
				column: 3,
			},
			{
				testId: "two-sum.zig:8",
				path: "src/two-sum.zig",
				name: "twoSum",
				line: 8,
				column: 1,
			},
		]);
	});

	it("unescapes quoted titles", () => {
		const tests = discoverTests([
			{ path: "main.zig", source: 'test "con \\"comillas\\"" {}\n' },
		]);
		expect(tests[0]?.name).toBe('con "comillas"');
	});
});

describe("matchRunnerName", () => {
	const catalog = discoverTests([
		{ path: "main.zig", source: 'test "suma basica" {}\n' },
		{
			path: "two-sum.zig",
			source: 'test "falla esperada" {}\ntest "a.test.b" {}\n',
		},
		{ path: "test/foo.zig", source: 'test "anidado" {}\n' },
	]);

	it("maps module-qualified names to their file", () => {
		expect(
			matchRunnerName(catalog, "src.two-sum.test.falla esperada")?.testId,
		).toBe("two-sum.zig:1");
		expect(matchRunnerName(catalog, "src.main.test.suma basica")?.testId).toBe(
			"main.zig:1",
		);
	});

	it("handles prefixes and titles containing .test.", () => {
		expect(matchRunnerName(catalog, "src.test.foo.test.anidado")?.testId).toBe(
			"test/foo.zig:1",
		);
		expect(matchRunnerName(catalog, "src.two-sum.test.a.test.b")?.testId).toBe(
			"two-sum.zig:2",
		);
	});

	it("falls back to a global title match", () => {
		expect(matchRunnerName(catalog, "otro.test.falla esperada")?.testId).toBe(
			"two-sum.zig:1",
		);
		expect(matchRunnerName(catalog, "src.main.test.desconocido")).toBe(
			undefined,
		);
	});
});

describe("TestEventReader", () => {
	it("parses start, result and summary events across chunks", () => {
		const events: RawTestEvent[] = [];
		const reader = new TestEventReader((event) => events.push(event));
		reader.push(
			Buffer.from(
				'{"protocolVersion":1,"kind":"test_start","index":0,"name":"src.main.test.a"}\n{"protocolVersion":1,"kind":"test_result","index":0,"na',
			),
		);
		reader.push(
			Buffer.from(
				'me":"src.main.test.a","status":"failed","durationNs":1200,"error":"TestExpectedEqual"}\n{"protocolVersion":1,"kind":"test_summary","passed":0,"failed":1,"skipped":0,"leaked":0}\n',
			),
		);
		reader.end();
		expect(events).toHaveLength(3);
		expect(events[1]).toMatchObject({
			kind: "test_result",
			status: "failed",
			error: "TestExpectedEqual",
		});
		expect(events[2]).toMatchObject({ kind: "test_summary", failed: 1 });
	});

	it("rejects invalid schemas and partial endings", () => {
		const reader = new TestEventReader(() => {});
		expect(() =>
			reader.push(
				Buffer.from('{"protocolVersion":1,"kind":"test_result","index":0}\n'),
			),
		).toThrow(/Invalid test result schema/);
		const partial = new TestEventReader(() => {});
		partial.push(Buffer.from('{"protocolVersion":1'));
		expect(() => partial.end()).toThrow(/partial NDJSON/);
	});
});
