import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instrument } from "./clive-instrument.mjs";

function run(source, lang) {
	const dir = mkdtempSync(join(tmpdir(), "clive-test-"));
	const inputPath = join(dir, lang === "cpp" ? "main.cpp" : "main.c");
	writeFileSync(inputPath, source);
	try {
		return instrument(source, {
			inputPath,
			inputName: inputPath.split("/").at(-1),
			uri: `file://${inputPath}`,
			lang,
			autoInspect: true,
			manualIds: [],
			fileId: 1,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const C_SAMPLE = `#include <stdio.h>

int apply_tax(int price, int tax) { return price + tax; }

int main(void) {
	int price = 40;
	double rate = 1.5;
	int total = apply_tax(price, 3);
	int a, b;
	for (int i = 0; i < 3; i++) {
		printf("iter %d\\n", i);
	}
	fprintf(stderr, "done\\n");
	return 0;
}
`;

test("C: probes simple declarations and skips for-init", () => {
	const result = run(C_SAMPLE, "c");
	assert.equal(
		(C_SAMPLE.match(/\n/g) ?? []).length,
		(result.generated.match(/\n/g) ?? []).length,
	);
	assert.match(result.generated, /int price = 40; __atomis_probe\("/);
	assert.match(result.generated, /"price", price\);/);
	assert.match(result.generated, /double rate = 1\.5; __atomis_probe\(/);
	assert.ok(!/int i = 0; __atomis_probe/.test(result.generated));
	const supported = result.probes.filter((probe) => probe.supported);
	assert.equal(supported.length, 3);
});

test("C: log markers use the comma operator and track loops", () => {
	const result = run(C_SAMPLE, "c");
	assert.match(
		result.generated,
		/printf\("iter %d\\n", i\), __atomis_log_loop\(1, 1, 11, \d+, 10, \d+, "i", i\)/,
	);
	assert.match(result.generated, /, __atomis_log\(2, 1, 13, \d+\)/);
});

test("C++: recovery keeps unknown-type declarations probed", () => {
	const source = `#include <string>\n#include <iostream>\n\nint main() {\n\tint price = 40;\n\tstd::string name = "x";\n\tstd::cout << name << price;\n\treturn 0;\n}\n`;
	const result = run(source, "cpp");
	assert.match(result.generated, /"price", price\);/);
	assert.match(result.generated, /"name", name\);/);
	assert.match(result.generated, /, __atomis_log\(1, 1, 7, \d+\)/);
});

test("passthrough for already instrumented sources", () => {
	const source = 'int main(void) { int x = 1; __atomis_probe("a", 1, 1, "x", x); }\n';
	const result = run(source, "c");
	assert.equal(result.generated, source);
	assert.equal(result.probes.length, 0);
});
