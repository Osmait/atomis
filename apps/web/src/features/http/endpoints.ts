/**
 * Endpoint detection: the routes a program declares, read from its source.
 *
 * Deliberately pattern-based rather than a parser per language: what it
 * has to recognise is how routes are *registered* — a call or decorator
 * with a method and a path literal — and those read the same in every
 * framework that matters for practice. It misses routes built at runtime
 * (paths in variables, loops); the history of requests fills that gap.
 */

export interface Endpoint {
	/** GET, POST, … or ANY when the code does not fix one. */
	method: string;
	path: string;
	file: string;
	line: number;
	/** What declared it, shown beside it: express, flask, net/http… */
	via: string;
}

interface ProjectFile {
	path: string;
	source: string;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const METHOD = "(get|post|put|patch|delete|head|options|all)";

type Rule = (line: string, context: LineContext) => { method: string; path: string; via: string }[];

interface LineContext {
	/** The Python method a line sits in (http.server's do_GET…). */
	pythonDef?: string;
	/** Lines of the file, for decorators that list methods further down. */
	lines: string[];
	index: number;
}

const upper = (method: string): string => (method.toLowerCase() === "all" ? "ANY" : method.toUpperCase());

/** `(app|router).get("/x", …)`: Express, Fastify, Hono, Koa router, chi, echo, cpp-httplib. */
const methodCall: Rule = (line) =>
	[...line.matchAll(new RegExp(`\\b\\w+\\.${METHOD}\\(\\s*["'\`](/[^"'\`]*)["'\`]`, "gi"))].map(
		(match) => ({ method: upper(match[1] ?? ""), path: match[2] ?? "", via: "route" }),
	);

/** Gin and echo spell the method in capitals: `r.GET("/x", …)`. */
const capitalCall: Rule = (line) =>
	[...line.matchAll(/\b\w+\.(GET|POST|PUT|PATCH|DELETE|Any)\(\s*"(\/[^"]*)"/g)].map((match) => ({
		method: upper(match[1] ?? ""),
		path: match[2] ?? "",
		via: "route",
	}));

/** Go's net/http: `HandleFunc("GET /x", …)` (1.22 patterns) or `Handle("/x", …)`. */
const goHandle: Rule = (line) =>
	[...line.matchAll(/\.(?:HandleFunc|Handle)\(\s*"(?:([A-Z]+)\s+)?(\/[^"]*)"/g)].map((match) => ({
		method: match[1] ?? "ANY",
		path: match[2] ?? "",
		via: "net/http",
	}));

/** Python decorators: FastAPI `@app.get("/x")`, Flask `@app.route("/x", methods=[…])`. */
const pythonDecorator: Rule = (line, context) => {
	const verb = line.match(new RegExp(`^\\s*@\\w+\\.${METHOD}\\(\\s*["'](/[^"']*)["']`, "i"));
	if (verb) return [{ method: upper(verb[1] ?? ""), path: verb[2] ?? "", via: "fastapi" }];
	const route = line.match(/^\s*@\w+\.route\(\s*["'](\/[^"']*)["']/);
	if (!route) return [];
	// The methods list may continue onto the next lines of the decorator.
	const call = context.lines.slice(context.index, context.index + 4).join(" ");
	const listed = call.match(/methods\s*=\s*\[([^\]]*)\]/);
	const methods = listed
		? [...(listed[1] ?? "").matchAll(/["'](\w+)["']/g)].map((match) => (match[1] ?? "").toUpperCase())
		: ["GET"];
	return methods.map((method) => ({ method, path: route[1] ?? "", via: "flask" }));
};

/** http.server: `self.path == "/x"` inside `do_GET`, `do_POST`… */
const pythonHttpServer: Rule = (line, context) => {
	if (!context.pythonDef) return [];
	return [...line.matchAll(/self\.path(?:\s*==\s*|\.startswith\(\s*)["'](\/[^"']*)["']/g)].map((match) => ({
		method: context.pythonDef ?? "ANY",
		path: match[1] ?? "",
		via: "http.server",
	}));
};

/** Node's http: `req.method === "GET" && req.url === "/x"`, either order, or the url alone. */
const nodeHttp: Rule = (line) => {
	const path = line.match(/\.url\s*={2,3}\s*["'`](\/[^"'`]*)["'`]|\.url\??\.startsWith\(\s*["'`](\/[^"'`]*)["'`]/);
	if (!path) return [];
	const method = line.match(/\.method\s*={2,3}\s*["'`]([A-Z]+)["'`]/);
	return [{ method: method?.[1] ?? "ANY", path: path[1] ?? path[2] ?? "", via: "node:http" }];
};

/** axum: `.route("/x", get(list).post(create))`. */
const axumRoute: Rule = (line) => {
	const route = line.match(/\.route\(\s*"(\/[^"]*)"\s*,(.*)/);
	if (!route) return [];
	const methods = [...(route[2] ?? "").matchAll(/\b(get|post|put|patch|delete|any)\s*\(/g)].map((match) =>
		upper(match[1] ?? ""),
	);
	return (methods.length ? methods : ["ANY"]).map((method) => ({ method, path: route[1] ?? "", via: "axum" }));
};

/** actix-web and rocket attributes: `#[get("/x")]`. */
const rustAttribute: Rule = (line) => {
	const match = line.match(/#\[(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/);
	return match ? [{ method: upper(match[1] ?? ""), path: match[2] ?? "", via: "actix" }] : [];
};

/** Crow: `CROW_ROUTE(app, "/x").methods("POST"_method)`. */
const crowRoute: Rule = (line) => {
	const match = line.match(/CROW_ROUTE\(\s*\w+\s*,\s*"(\/[^"]*)"\s*\)(.*)/);
	if (!match) return [];
	const methods = [...(match[2] ?? "").matchAll(/"(\w+)"_method/g)].map((method) => (method[1] ?? "").toUpperCase());
	return (methods.length ? methods : ["GET"]).map((method) => ({ method, path: match[1] ?? "", via: "crow" }));
};

/** Zig's std.http: `std.mem.eql(u8, request.head.target, "/x")`. */
const zigTarget: Rule = (line) =>
	[...line.matchAll(/\.target\s*,\s*"(\/[^"]*)"/g)].map((match) => ({
		method: "ANY",
		path: match[1] ?? "",
		via: "std.http",
	}));

/** Servers written on raw sockets compare the request line: `"GET /x"`. */
const requestLine: Rule = (line) =>
	[...line.matchAll(/["'](GET|POST|PUT|PATCH|DELETE) (\/[^\s"']*)/g)].map((match) => ({
		method: match[1] ?? "ANY",
		path: match[2] ?? "",
		via: "request line",
	}));

/**
 * Hand-written routing compares the method and the path on one line:
 * `("GET", "/todos") =>` in Rust, `strcmp(method, "GET") == 0 && strcmp(path,
 * "/todos") == 0` in C. A method literal beside a path literal is a route.
 */
const methodBesidePath: Rule = (line) => {
	const method = line.match(/["'](GET|POST|PUT|PATCH|DELETE)["']/);
	const path = line.match(/["'](\/[A-Za-z0-9_\-./{}:]*)["']/);
	return method && path ? [{ method: method[1] ?? "ANY", path: path[1] ?? "", via: "hand-written" }] : [];
};

const RULES: Record<string, Rule[]> = {
	ts: [methodCall, nodeHttp, methodBesidePath],
	js: [methodCall, nodeHttp, methodBesidePath],
	mjs: [methodCall, nodeHttp, methodBesidePath],
	py: [pythonDecorator, pythonHttpServer, methodBesidePath],
	go: [goHandle, capitalCall, methodCall],
	rs: [axumRoute, rustAttribute, requestLine, methodBesidePath],
	c: [requestLine, methodBesidePath],
	h: [requestLine, methodBesidePath],
	cpp: [methodCall, crowRoute, requestLine, methodBesidePath],
	cc: [methodCall, crowRoute, requestLine, methodBesidePath],
	hpp: [methodCall, crowRoute, requestLine, methodBesidePath],
	zig: [zigTarget, requestLine, methodBesidePath],
};

const isTest = (path: string): boolean => /(^|\/)(main_test\.|.*\.test\.|.*_test\.)/.test(path);

/** Every route the project's source declares, in file and line order. */
export function detectEndpoints(files: readonly ProjectFile[]): Endpoint[] {
	const found: Endpoint[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const extension = file.path.split(".").pop() ?? "";
		const rules = RULES[extension];
		if (!rules || isTest(file.path)) continue;
		const lines = file.source.split("\n");
		let pythonDef: string | undefined;
		lines.forEach((text, index) => {
			if (extension === "py") {
				const def = text.match(/^\s*def\s+(\w+)/);
				if (def) {
					const verb = def[1]?.match(/^do_([A-Z]+)$/)?.[1];
					pythonDef = verb && METHODS.has(verb) ? verb : undefined;
				}
			}
			if (/^\s*(\/\/|#(?!\[))/.test(text)) return;
			for (const rule of rules) {
				for (const route of rule(text, { lines, index, ...(pythonDef ? { pythonDef } : {}) })) {
					const key = `${route.method} ${route.path}`;
					if (!route.path || seen.has(key)) continue;
					seen.add(key);
					found.push({ ...route, file: file.path, line: index + 1 });
				}
			}
		});
	}
	return found;
}

/** A path ready to send: `:id`, `{id}` and `<int:id>` become `1`. */
export function samplePath(path: string): string {
	return path
		.replaceAll(/:\w+/g, "1")
		.replaceAll(/\{[^}]+\}/g, "1")
		.replaceAll(/<[^>]+>/g, "1")
		.replaceAll(/\*\w*$/g, "");
}
