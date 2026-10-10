// A mini Redis: an in-memory key-value store that logs every write to a
// file, and replays (then compacts) that log the next time it starts.
// Press Run and type commands under the output: SET name Ada, GET name,
// INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
// Run it again: the data is still there. Auto Run replays the Input text.
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = "../redis.aof"; // beside src/, so it is not one of your project files
const COMMANDS = new Set(["SET", "GET", "DEL", "EXISTS", "INCR", "KEYS", "DBSIZE", "FLUSHALL"]);

/** Rebuilds the store from the log: the cache starts as the file left it. */
export function replay(text: string): { store: Map<string, string>; entries: number } {
	const store = new Map<string, string>();
	let entries = 0;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		entries++;
		const space = line.indexOf(" ");
		const op = space < 0 ? line : line.slice(0, space);
		const rest = space < 0 ? "" : line.slice(space + 1);
		if (op === "SET") {
			const gap = rest.indexOf(" ");
			store.set(gap < 0 ? rest : rest.slice(0, gap), gap < 0 ? "" : rest.slice(gap + 1));
		} else if (op === "DEL") {
			store.delete(rest);
		} else if (op === "FLUSHALL") {
			store.clear();
		}
	}
	return { store, entries };
}

let previous = "";
try {
	previous = readFileSync(LOG, "utf8");
} catch {
	// No log yet: a new database.
}
const { store, entries } = replay(previous);
console.log(`loaded ${store.size} keys (${entries} log entries) from redis.aof`);

// Compaction: the log restarts as one SET per key, then grows a line per write.
const log = openSync(LOG, "w");
const append = (entry: string): void => {
	writeSync(log, `${entry}\n`);
};
const sortedKeys = (): string[] => [...store.keys()].sort();
for (const key of sortedKeys()) append(`SET ${key} ${store.get(key)}`);

function execute(words: string[]): string {
	const command = words[0]!.toUpperCase();
	const args = words.slice(1);
	if (command === "SET" && args.length >= 2) {
		const value = args.slice(1).join(" ");
		store.set(args[0]!, value);
		append(`SET ${args[0]} ${value}`);
		return "OK";
	}
	if (command === "GET" && args.length === 1) {
		const value = store.get(args[0]!);
		return value === undefined ? "(nil)" : `"${value}"`;
	}
	if (command === "DEL" && args.length === 1) {
		if (!store.delete(args[0]!)) return "(integer) 0";
		append(`DEL ${args[0]}`);
		return "(integer) 1";
	}
	if (command === "EXISTS" && args.length === 1) {
		return `(integer) ${store.has(args[0]!) ? 1 : 0}`;
	}
	if (command === "INCR" && args.length === 1) {
		const current = store.get(args[0]!) ?? "0";
		const number = /^[+-]?\d+$/.test(current) ? Number(current) + 1 : Number.NaN;
		if (!Number.isSafeInteger(number)) return "(error) ERR value is not an integer or out of range";
		store.set(args[0]!, String(number));
		append(`SET ${args[0]} ${number}`);
		return `(integer) ${number}`;
	}
	if (command === "KEYS" && args.length <= 1) {
		const keys = sortedKeys();
		return keys.length ? keys.map((key, i) => `${i + 1}) "${key}"`).join("\n") : "(empty array)";
	}
	if (command === "DBSIZE" && args.length === 0) return `(integer) ${store.size}`;
	if (command === "FLUSHALL" && args.length === 0) {
		store.clear();
		append("FLUSHALL");
		return "OK";
	}
	if (COMMANDS.has(command)) {
		return `(error) ERR wrong number of arguments for '${words[0]!.toLowerCase()}'`;
	}
	return `(error) ERR unknown command '${words[0]}'`;
}

console.log("mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT");
const lines = createInterface({ input: process.stdin });
process.stdout.write("redis> ");
for await (const line of lines) {
	const words = line.split(/\s+/).filter(Boolean);
	if (words[0]?.toUpperCase() === "QUIT") break;
	if (words.length) console.log(execute(words));
	process.stdout.write("redis> ");
}
lines.close();
closeSync(log);
console.log("bye");
