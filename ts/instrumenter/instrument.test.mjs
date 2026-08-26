import { test } from "node:test";
import assert from "node:assert/strict";
import { instrument } from "./instrument.mjs";

const sample = `const price: number = 40;
let tax = 3
const total = applyTax(price, tax);
const [a, b] = [1, 2];
var sum, rest;
for (let i = 0; i < 3; i++) {
	console.log("iter", i);
}
for (const v of [1, 2]) {
	console.error("v", v);
}
console.log("total:", total);
function applyTax(price: number, tax: number): number {
	const inner = price + tax;
	return inner;
}
`;

test("probes simple declarations, top level included", () => {
	const result = instrument(sample, "file:///main.ts", true, [], 1);
	assert.ok(result.generated);
	assert.equal(
		(sample.match(/\n/g) ?? []).length,
		(result.generated.match(/\n/g) ?? []).length,
	);
	assert.match(result.generated, /price: number = 40;; __ziglive_probe\(/);
	assert.match(result.generated, /"price", price\);/);
	// ASI case: no original semicolon, ours is added before the call
	assert.match(result.generated, /let tax = 3; __ziglive_probe\(/);
	assert.match(result.generated, /const inner = price \+ tax;; __ziglive_probe\(/);
	const supported = result.probes.filter((probe) => probe.supported);
	const unsupported = result.probes.filter((probe) => !probe.supported);
	// price, tax, total, inner (destructuring + multi-decl unsupported;
	// for-loop declarations are not VariableStatements and stay untouched)
	assert.equal(supported.length, 4);
	assert.equal(unsupported.length, 2);
	assert.ok(!/let i = 0; __ziglive_probe/.test(result.generated));
});

test("log markers pick the console stream and track loops", () => {
	const result = instrument(sample, "file:///main.ts", true, [], 7);
	assert.match(
		result.generated,
		/__ziglive_log_loop\(1, 7, 7, 2, 6, 1, "i", i\);/,
	);
	assert.match(
		result.generated,
		/__ziglive_log_loop\(2, 7, 10, 2, 9, 1, "v", v\);/,
	);
	assert.match(result.generated, /__ziglive_log\(1, 7, 12, 1\);/);
});

test("manual mode inserts only selected ids", () => {
	const all = instrument(sample, "file:///main.ts", true, [], 1);
	const price = all.probes.find((probe) => probe.name === "price");
	const none = instrument(sample, "file:///main.ts", false, [], 1);
	assert.ok(!none.generated.includes("__ziglive_probe"));
	const selected = instrument(
		sample,
		"file:///main.ts",
		false,
		[price.probeId],
		1,
	);
	assert.match(selected.generated, /"price", price\);/);
});

test("parse errors carry positions and skip generation", () => {
	const result = instrument(
		"const x = ;\n",
		"file:///main.ts",
		true,
		[],
		1,
	);
	assert.equal(result.generated, undefined);
	assert.equal(result.parseDiagnostics[0].line, 1);
	assert.ok(result.parseDiagnostics[0].column >= 10);
});

test("plain JavaScript parses with the JS script kind", () => {
	const result = instrument(
		"const x = 5\nconsole.log(x)\n",
		"file:///main.js",
		true,
		[],
		1,
	);
	assert.match(result.generated, /const x = 5; __ziglive_probe\(/);
});

test("instrumented sources pass through unchanged", () => {
	const source = 'const x = 1; __ziglive_probe("a", 1, 7, "x", x);\n';
	const result = instrument(source, "file:///main.ts", true, [], 1);
	assert.equal(result.generated, source);
	assert.equal(result.probes.length, 0);
});
