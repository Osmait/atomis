// A REST API for a todo list, on node:http alone.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Todo = { id: number; title: string; done: boolean };
type Params = Record<string, string>;
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => void | Promise<void>;
type Route = [method: string, path: string, handler: Handler];

const todos = new Map<number, Todo>(); // a Map keeps creation order
let nextId = 1;

function reply(res: ServerResponse, status: number, payload?: unknown): void {
	const body = payload === undefined ? "" : JSON.stringify(payload);
	const headers: Record<string, string | number> = { "content-length": Buffer.byteLength(body) };
	if (payload !== undefined) headers["content-type"] = "application/json";
	res.writeHead(status, headers);
	res.end(body);
}

/** The body parsed as JSON, or null when it is empty or not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The todo the {id} names, or undefined after answering 404. */
function findTodo(res: ServerResponse, params: Params): Todo | undefined {
	const todo = /^\d+$/.test(params.id) ? todos.get(Number(params.id)) : undefined;
	if (!todo) reply(res, 404, { error: "not found" });
	return todo;
}

function health(_req: IncomingMessage, res: ServerResponse): void {
	reply(res, 200, { ok: true });
}

function listTodos(_req: IncomingMessage, res: ServerResponse): void {
	reply(res, 200, [...todos.values()]);
}

async function createTodo(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const data = await readJson(req);
	const title = isObject(data) ? data.title : undefined;
	if (typeof title !== "string" || title === "") return reply(res, 400, { error: "title is required" });
	const todo: Todo = { id: nextId++, title, done: false };
	todos.set(todo.id, todo);
	reply(res, 201, todo);
}

function getTodo(_req: IncomingMessage, res: ServerResponse, params: Params): void {
	const todo = findTodo(res, params);
	if (todo) reply(res, 200, todo);
}

async function updateTodo(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
	const todo = findTodo(res, params);
	if (!todo) return;
	const data = await readJson(req);
	if (isObject(data) && typeof data.done === "boolean") todo.done = data.done;
	reply(res, 200, todo);
}

function deleteTodo(_req: IncomingMessage, res: ServerResponse, params: Params): void {
	const todo = findTodo(res, params);
	if (!todo) return;
	todos.delete(todo.id);
	reply(res, 204);
}

// The route table: what a framework's router keeps for you.
const routes: Route[] = [
	["GET", "/health", health],
	["GET", "/todos", listTodos],
	["POST", "/todos", createTodo],
	["GET", "/todos/{id}", getTodo],
	["PATCH", "/todos/{id}", updateTodo],
	["DELETE", "/todos/{id}", deleteTodo],
];

/** Turns "/todos/{id}" into /^\/todos\/(?<id>[^/]+)$/: each {name} captures one segment. */
function compile(path: string): RegExp {
	const escaped = path.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`);
}

const table = routes.map(([method, path, handler]) => ({ method, pattern: compile(path), handler }));

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const path = (req.url ?? "/").split("?")[0];
	for (const { method, pattern, handler } of table) {
		const match = pattern.exec(path);
		if (match && req.method === method) return handler(req, res, { ...match.groups });
	}
	reply(res, 404, { error: "not found" });
}

const port = Number(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
createServer((req, res) => void dispatch(req, res)).listen(port, host, () => {
	console.log(`listening on ${port}`);
});
