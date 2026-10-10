import type { Language } from "@atomis/protocol";
import type { StdinMode } from "../../shared/stores/settings.js";
import { WEB_LANGUAGE_PACKS } from "../editor/languagePacks.js";

// The programs live in demos/ at the repository root as real source files —
// readable, runnable and checked by the e2e suite as they are — and are
// bundled here verbatim.
import replZig from "../../../../../demos/repl/main.zig?raw";
import replRust from "../../../../../demos/repl/main.rs?raw";
import replGo from "../../../../../demos/repl/main.go?raw";
// A ?raw import is the file's text: the linter resolves it to the module
// and looks for exports a program has no reason to have.
// eslint-disable-next-line import/default
import replTs from "../../../../../demos/repl/main.ts?raw";
import replPy from "../../../../../demos/repl/main.py?raw";
import replC from "../../../../../demos/repl/main.c?raw";
import replCpp from "../../../../../demos/repl/main.cpp?raw";
import redisZig from "../../../../../demos/redis/main.zig?raw";
import redisRust from "../../../../../demos/redis/main.rs?raw";
import redisGo from "../../../../../demos/redis/main.go?raw";
// eslint-disable-next-line import/default
import redisTs from "../../../../../demos/redis/main.ts?raw";
import redisPy from "../../../../../demos/redis/main.py?raw";
import redisC from "../../../../../demos/redis/main.c?raw";
import redisCpp from "../../../../../demos/redis/main.cpp?raw";
import restZig from "../../../../../demos/rest/main.zig?raw";
import restRust from "../../../../../demos/rest/main.rs?raw";
import restGo from "../../../../../demos/rest/main.go?raw";
// eslint-disable-next-line import/default
import restTs from "../../../../../demos/rest/main.ts?raw";
import restPy from "../../../../../demos/rest/main.py?raw";
import restC from "../../../../../demos/rest/main.c?raw";
import restCpp from "../../../../../demos/rest/main.cpp?raw";
// eslint-disable-next-line import/default
import expressTs from "../../../../../demos/rest-express/main.ts?raw";
import expressDeps from "../../../../../demos/rest-express/dependencies.json?raw";
import fastapiPy from "../../../../../demos/rest-fastapi/main.py?raw";
import fastapiDeps from "../../../../../demos/rest-fastapi/dependencies.json?raw";
import ginGo from "../../../../../demos/rest-gin/main.go?raw";
import ginDeps from "../../../../../demos/rest-gin/dependencies.json?raw";
import axumRust from "../../../../../demos/rest-axum/main.rs?raw";
import axumDeps from "../../../../../demos/rest-axum/dependencies.json?raw";

/** A framework demo's dependencies: demos/<dir>/dependencies.json, which the
 * e2e suite reads too, so the two cannot disagree. */
const deps = (json: string): string[] => JSON.parse(json) as string[];

/** One idea, shown in every language that has a take on it. */
export interface DemoKind {
	id: string;
	title: string;
	summary: string;
	/** The Input text the demo opens with: what Auto Run feeds it. */
	input?: string;
	/** Where Run reads stdin from while the demo is open. */
	stdinMode?: StdinMode;
	/** Opens running as a server, with the HTTP view showing. */
	serve?: boolean;
	sources: Partial<Record<Language, string>>;
	/** Packages each language's version installs before its first run,
	 * as the Dependencies view takes them. */
	dependencies?: Partial<Record<Language, string[]>>;
	/** What sets a language's version apart, shown beside it: a framework. */
	variants?: Partial<Record<Language, string>>;
}

/** A demo as it opens: a fresh scratch session with these files. */
export interface Demo {
	id: string;
	kind: DemoKind;
	language: Language;
	files: { path: string; source: string }[];
	dependencies: string[];
	variant?: string;
}

export const DEMO_KINDS: readonly DemoKind[] = [
	{
		id: "repl",
		title: "Calculator REPL",
		summary:
			"Reads your input line by line: run it and answer under the output — 2 + 3, sum, help, quit. Auto Run plays a sample session from the Input text.",
		input: "2 + 3\n10 / 4\n7 / 0\nsum\nquit\n",
		stdinMode: "terminal",
		sources: {
			zig: replZig,
			rust: replRust,
			go: replGo,
			ts: replTs,
			py: replPy,
			c: replC,
			cpp: replCpp,
		},
	},
	{
		id: "redis",
		title: "Mini Redis",
		summary:
			"A key-value store with a redis-cli REPL — SET, GET, DEL, EXISTS, INCR, KEYS, DBSIZE, FLUSHALL. Every write goes to a log file that the next run replays into memory: run it twice and the data is still there.",
		// Each Auto Run bumps `visits`: persistence you can watch.
		input: "SET greeting hello\nINCR visits\nGET greeting\nKEYS\nQUIT\n",
		stdinMode: "terminal",
		sources: {
			zig: redisZig,
			rust: redisRust,
			go: redisGo,
			ts: redisTs,
			py: redisPy,
			c: redisC,
			cpp: redisCpp,
		},
	},
	{
		id: "rest",
		title: "REST API",
		summary:
			"A todo-list API on the standard library alone — routes, JSON and status codes written out by hand, the way a framework would. Opens running as a server, with its endpoints in the HTTP view to call.",
		serve: true,
		sources: {
			zig: restZig,
			rust: restRust,
			go: restGo,
			ts: restTs,
			py: restPy,
			c: restC,
			cpp: restCpp,
		},
	},
	{
		id: "rest-framework",
		title: "REST API on a framework",
		summary:
			"The same todo-list API on the framework people use for it. Its packages install when it opens (the first run of axum compiles them, so give it a minute), then it serves.",
		serve: true,
		sources: { ts: expressTs, py: fastapiPy, go: ginGo, rust: axumRust },
		variants: { ts: "Express", py: "FastAPI", go: "gin", rust: "axum" },
		dependencies: {
			ts: deps(expressDeps),
			py: deps(fastapiDeps),
			go: deps(ginDeps),
			rust: deps(axumDeps),
		},
	},
];

/** Every demo of a kind, in the editor's language order. */
export function demosOf(kind: DemoKind): Demo[] {
	return (Object.keys(WEB_LANGUAGE_PACKS) as Language[]).flatMap((language) => {
		const source = kind.sources[language];
		if (source === undefined) return [];
		const path = WEB_LANGUAGE_PACKS[language].entryFile;
		const variant = kind.variants?.[language];
		return [
			{
				id: `${kind.id}-${language}`,
				kind,
				language,
				files: [{ path, source }],
				dependencies: kind.dependencies?.[language] ?? [],
				...(variant ? { variant } : {}),
			},
		];
	});
}
