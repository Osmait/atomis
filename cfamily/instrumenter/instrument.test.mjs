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

test("C: bytes before an insertion point do not shift the splice", () => {
	// The comment carries multibyte characters; clang's offsets are bytes,
	// and slicing by UTF-16 units used to land every later insertion a few
	// bytes early — inside a token.
	const source = `// año señor 🎉 medición
int main(void) {
	int price = 40;
	return price;
}
`;
	const result = run(source, "c");
	assert.match(result.generated, /int price = 40; __atomis_probe\("/);
	// The splice landed exactly after the semicolon, not mid-token.
	assert.ok(!result.generated.includes("40 ;"));
	assert.equal(
		(source.match(/\n/g) ?? []).length,
		(result.generated.match(/\n/g) ?? []).length,
	);
});

test("C++: an if-init declaration stays inside its parentheses", () => {
	const source = `int f() { return 3; }
int main() {
	if (int x = f(); x > 0) {
		return x;
	}
	return 0;
}
`;
	const result = run(source, "cpp");
	assert.ok(
		!/f\(\);[^)]*__atomis_probe/.test(result.generated),
		`probe spliced into the if header:\n${result.generated}`,
	);
});

test("C++: a lambda body does not borrow the enclosing loop's variable", () => {
	const source = `#include <cstdio>
int main() {
	for (int i = 0; i < 2; i++) {
		auto f = []() { printf("x\\n"); };
		f();
	}
	return 0;
}
`;
	const result = run(source, "cpp");
	assert.ok(
		!result.generated.includes("__atomis_log_loop"),
		`loop marker inside a lambda cannot capture i:\n${result.generated}`,
	);
});

test("C++: a cout line inside a raw string is data, not a statement", () => {
	const source = `#include <iostream>
int main() {
	const char *doc = R"(
std::cout << x;
)";
	std::cout << doc;
	return 0;
}
`;
	const result = run(source, "cpp");
	// One marker for the real cout; none spliced into the raw string.
	assert.ok(
		!result.generated.includes('std::cout << x;, __atomis_log'),
		`marker spliced into string content:\n${result.generated}`,
	);
});
