// A REST API for a todo list, on Express.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
import express, { type NextFunction, type Request, type Response } from "express";

type Todo = { id: number; title: string; done: boolean };

const todos = new Map<number, Todo>(); // a Map keeps creation order
let nextId = 1;

const app = express();
// strict: false so a bare string or number parses too; the routes reject it.
app.use(express.json({ strict: false }));

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The todo the :id names, or undefined after answering 404. */
function findTodo(req: Request<{ id: string }>, res: Response): Todo | undefined {
	const todo = /^\d+$/.test(req.params.id) ? todos.get(Number(req.params.id)) : undefined;
	if (!todo) res.status(404).json({ error: "not found" });
	return todo;
}

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.get("/todos", (_req, res) => {
	res.json([...todos.values()]);
});

app.post("/todos", (req, res) => {
	const body: unknown = req.body;
	const title = isObject(body) ? body.title : undefined;
	if (typeof title !== "string" || title === "") {
		res.status(400).json({ error: "title is required" });
		return;
	}
	const todo: Todo = { id: nextId++, title, done: false };
	todos.set(todo.id, todo);
	res.status(201).json(todo);
});

// Express 5 dropped regex params, so findTodo checks that :id is digits.
app.get("/todos/:id", (req, res) => {
	const todo = findTodo(req, res);
	if (todo) res.json(todo);
});

app.patch("/todos/:id", (req, res) => {
	const todo = findTodo(req, res);
	if (!todo) return;
	const body: unknown = req.body;
	if (isObject(body) && typeof body.done === "boolean") todo.done = body.done;
	res.json(todo);
});

app.delete("/todos/:id", (req, res) => {
	const todo = findTodo(req, res);
	if (!todo) return;
	todos.delete(todo.id);
	res.status(204).end();
});

// Any other path: a JSON 404 instead of Express's HTML one.
app.use((_req, res) => {
	res.status(404).json({ error: "not found" });
});

// Error handlers take four arguments. A body that is not JSON lands here
// (Express would answer with an HTML 400); for POST /todos that means no title.
app.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
	if (error.type === "entity.parse.failed") {
		res.status(400).json({ error: "title is required" });
		return;
	}
	res.status(error.status ?? 500).json({ error: error.message });
});

const port = Number(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
	console.log(`listening on ${port}`);
});
