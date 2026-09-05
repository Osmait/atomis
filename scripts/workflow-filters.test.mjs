import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const docker = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");

function eventConfig(workflow, event) {
	const block = workflow.split(`\n  ${event}:\n`)[1]?.split(/\n(?=\S| {2}\S)/)[0];
	assert.ok(block, `Missing ${event} trigger`);
	return block;
}

function ignoredPaths(event) {
	const raw = eventConfig(ci, event).match(/paths-ignore: (\[[^\n]+\])/);
	assert.ok(raw, `Missing ${event} path filter`);
	return JSON.parse(raw[1]);
}

for (const event of ["push", "pull_request"]) {
	const ignored = ignoredPaths(event);
	const runs = (paths) => paths.some((path) => !ignored.some((glob) => matchesGlob(path, glob)));

	test(`${event}: documentation-only changes do not run CI`, () => {
		for (const path of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "docs/protocols.md", "docs/images/atomis-mobile.png", "apps/web/README.md"]) {
			assert.equal(runs([path]), false, path);
		}
		assert.equal(runs(["README.md", "docs/images/atomis-desktop.png"]), false);
	});

	test(`${event}: code, app assets and build/test inputs still run CI`, () => {
		for (const path of [
			"apps/web/src/app/App.tsx", "apps/web/src/styles/editor.css", "apps/web/public/favicon.png",
			"apps/server-rs/src/main.rs", "apps/desktop/src-tauri/tauri.conf.json", "packages/protocol/src/index.ts",
			"zig/runtime.zig", "rust/runtime/lib.rs", "go/runtime/runtime.go", "python/instrumenter/instrument.py",
			"ts/instrumenter/instrument.mjs", "cfamily/runtime/atomis_runtime.hpp", "fixtures/valid/inline-values.zig",
			"assets/logo.png", "tests/e2e/atomis.spec.ts", "scripts/workflow-filters.test.mjs",
			"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "build.zig", "build.zig.zon",
			"tsconfig.base.json", "playwright.config.ts", ".oxlintrc.json", ".clangd",
			"Dockerfile", ".dockerignore", ".github/workflows/ci.yml", "new-language/runtime/source.ext",
		]) {
			assert.equal(runs([path]), true, path);
		}
	});

	test(`${event}: mixed changes and renamed/deleted code paths still run CI`, () => {
		assert.equal(runs(["README.md", "apps/web/src/removed.ts"]), true);
		assert.equal(runs(["apps/web/src/old.ts", "docs/archived.md"]), true);
	});

	test(`${event}: Docker validates its configuration and its own workflow`, () => {
		const block = eventConfig(docker, event);
		const paths = [...block.matchAll(/^      - (.+)$/gm)].map((match) => match[1]);
		assert.deepEqual(paths, ["Dockerfile", ".dockerignore", ".github/workflows/docker.yml"]);
	});
}

test("push and pull request filters stay consistent", () => {
	assert.deepEqual(ignoredPaths("push"), ignoredPaths("pull_request"));
});
