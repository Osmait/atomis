import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectEndpoints, samplePath } from "./endpoints.js";

const routes = (path: string, source: string): string[] =>
	detectEndpoints([{ path, source }]).map((endpoint) => `${endpoint.method} ${endpoint.path} :${endpoint.line} ${endpoint.via}`);

describe("detectEndpoints", () => {
	it("reads Express-style routes", () => {
		const source = [
			'import express from "express";',
			"const app = express();",
			'app.get("/items", (req, res) => res.json(items));',
			"app.post('/items', create);",
			"router.delete(`/items/:id`, remove);",
			'app.all("/health", ok);',
		].join("\n");
		expect(routes("main.ts", source)).toEqual([
			"GET /items :3 route",
			"POST /items :4 route",
			"DELETE /items/:id :5 route",
			"ANY /health :6 route",
		]);
	});

	it("reads node:http comparisons, with or without a method", () => {
		const source = [
			'if (req.method === "POST" && req.url === "/items") create();',
			'if (req.url?.startsWith("/items")) list();',
		].join("\n");
		expect(routes("main.ts", source)).toEqual(["POST /items :1 node:http", "ANY /items :2 node:http"]);
	});

	it("reads FastAPI and Flask decorators, Flask's methods list included", () => {
		const source = [
			"@app.get('/items')",
			"def list_items(): ...",
			'@router.post("/items")',
			"def create(): ...",
			'@app.route("/users/<int:id>", methods=["GET", "DELETE"])',
			"def user(id): ...",
			'@app.route("/ping")',
			"def ping(): ...",
		].join("\n");
		expect(routes("main.py", source)).toEqual([
			"GET /items :1 fastapi",
			"POST /items :3 fastapi",
			"GET /users/<int:id> :5 flask",
			"DELETE /users/<int:id> :5 flask",
			"GET /ping :7 flask",
		]);
	});

	it("reads http.server paths under the method that handles them", () => {
		const source = [
			"class Handler(BaseHTTPRequestHandler):",
			"    def do_GET(self):",
			'        if self.path == "/health":',
			"            ...",
			'        elif self.path.startswith("/items"):',
			"            ...",
			"    def do_POST(self):",
			'        if self.path == "/items":',
			"            ...",
		].join("\n");
		expect(routes("main.py", source)).toEqual([
			"GET /health :3 http.server",
			"GET /items :5 http.server",
			"POST /items :8 http.server",
		]);
	});

	it("reads Go: net/http patterns with and without a method, and gin", () => {
		const source = [
			'http.HandleFunc("GET /items", list)',
			'mux.Handle("/static/", files)',
			'r.POST("/items", create)',
			'r.Get("/users/{id}", user)',
		].join("\n");
		expect(routes("main.go", source)).toEqual([
			"GET /items :1 net/http",
			"ANY /static/ :2 net/http",
			"POST /items :3 route",
			"GET /users/{id} :4 route",
		]);
	});

	it("reads axum routes with every method they chain, and actix attributes", () => {
		const source = [
			'.route("/items", get(list).post(create))',
			'.route("/items/:id", delete(remove))',
			'#[get("/health")]',
		].join("\n");
		expect(routes("main.rs", source)).toEqual([
			"GET /items :1 axum",
			"POST /items :1 axum",
			"DELETE /items/:id :2 axum",
			"GET /health :3 actix",
		]);
	});

	it("reads cpp-httplib, Crow, Zig's std.http and hand-written request lines", () => {
		expect(routes("main.cpp", 'svr.Get("/hi", handler);\nCROW_ROUTE(app, "/items").methods("POST"_method)')).toEqual([
			"GET /hi :1 route",
			"POST /items :2 crow",
		]);
		expect(routes("main.zig", 'if (std.mem.eql(u8, request.head.target, "/health")) {')).toEqual([
			"ANY /health :1 std.http",
		]);
		expect(routes("main.c", 'if (strncmp(buf, "GET /health", 11) == 0)')).toEqual(["GET /health :1 request line"]);
	});

	it("reads hand-written routing that compares method and path on one line", () => {
		expect(routes("main.rs", '        ("GET", "/todos") => list(&todos),')).toEqual(["GET /todos :1 hand-written"]);
		expect(
			routes("main.c", 'if (strcmp(method, "POST") == 0 && strcmp(path, "/todos") == 0) create();'),
		).toEqual(["POST /todos :1 hand-written"]);
		// A method alone, or a path alone, is not a route.
		expect(routes("main.c", 'if (strcmp(method, "GET") == 0) {')).toEqual([]);
	});

	it("skips comments, test files and repeats", () => {
		expect(
			routes("main.ts", '// app.get("/old", x)\napp.get("/items", a);\napp.get("/items", b);'),
		).toEqual(["GET /items :2 route"]);
		expect(routes("main.test.ts", 'app.get("/items", a);')).toEqual([]);
	});

	it("turns path parameters into something sendable", () => {
		expect(samplePath("/items/:id")).toBe("/items/1");
		expect(samplePath("/users/{id}/posts/{post}")).toBe("/users/1/posts/1");
		expect(samplePath("/users/<int:id>")).toBe("/users/1");
	});
});

describe("the REST demos", () => {
	const demos = new URL("../../../../../demos/", import.meta.url);
	const versions = ["rest", "rest-express", "rest-fastapi", "rest-gin", "rest-axum"].flatMap((dir) =>
		readdirSync(new URL(`${dir}/`, demos))
			.filter((file) => file.startsWith("main."))
			.map((file) => `${dir}/${file}`),
	);

	it("are all found", () => {
		expect(versions).toHaveLength(11);
	});

	// The HTTP view is how the demo is meant to be used: every route of the
	// contract has to be listed, ready to send, in every version.
	it.each(versions)("lists all six routes of %s", (version) => {
		const source = readFileSync(new URL(version, demos), "utf8");
		const listed = new Set(
			detectEndpoints([{ path: version.split("/")[1] ?? "", source }]).map(
				(endpoint) => `${endpoint.method} ${samplePath(endpoint.path)}`,
			),
		);
		for (const route of ["GET /health", "GET /todos", "POST /todos", "GET /todos/1", "PATCH /todos/1", "DELETE /todos/1"])
			expect(listed, `${version} should list ${route}`).toContain(route);
	});
});
