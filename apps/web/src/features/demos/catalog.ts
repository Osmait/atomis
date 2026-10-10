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

/** One idea, shown in every language that has a take on it. */
export interface DemoKind {
	id: string;
	title: string;
	summary: string;
	/** The Input text the demo opens with: what Auto Run feeds it. */
	input?: string;
	/** Where Run reads stdin from while the demo is open. */
	stdinMode?: StdinMode;
	sources: Partial<Record<Language, string>>;
}

/** A demo as it opens: a fresh scratch session with these files. */
export interface Demo {
	id: string;
	kind: DemoKind;
	language: Language;
	files: { path: string; source: string }[];
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
];

/** Every demo of a kind, in the editor's language order. */
export function demosOf(kind: DemoKind): Demo[] {
	return (Object.keys(WEB_LANGUAGE_PACKS) as Language[]).flatMap((language) => {
		const source = kind.sources[language];
		if (source === undefined) return [];
		const path = WEB_LANGUAGE_PACKS[language].entryFile;
		return [
			{ id: `${kind.id}-${language}`, kind, language, files: [{ path, source }] },
		];
	});
}
