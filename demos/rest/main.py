# A REST API for a todo list, on the standard library alone.
# Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
# call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
# GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
# The data lives in memory: an edit restarts the server, and it with it.
# ROUTES below is what a framework's router keeps for you.
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

todos = {}
next_id = 1


def health(request):
    return 200, {"ok": True}


def list_todos(request):
    return 200, list(todos.values())


def create_todo(request):
    global next_id
    data = request.json()
    title = data.get("title") if isinstance(data, dict) else None
    if not isinstance(title, str) or not title:
        return 400, {"error": "title is required"}
    todo = {"id": next_id, "title": title, "done": False}
    todos[next_id] = todo
    next_id += 1
    return 201, todo


def get_todo(request, id):
    todo = todos.get(int(id))
    return (200, todo) if todo else (404, {"error": "not found"})


def update_todo(request, id):
    todo = todos.get(int(id))
    if not todo:
        return 404, {"error": "not found"}
    data = request.json()
    if isinstance(data, dict) and isinstance(data.get("done"), bool):
        todo["done"] = data["done"]
    return 200, todo


def delete_todo(request, id):
    if todos.pop(int(id), None) is None:
        return 404, {"error": "not found"}
    return 204, None


ROUTES = [
    ("GET", "/health", health),
    ("GET", "/todos", list_todos),
    ("POST", "/todos", create_todo),
    ("GET", "/todos/{id}", get_todo),
    ("PATCH", "/todos/{id}", update_todo),
    ("DELETE", "/todos/{id}", delete_todo),
]


def compile_pattern(path):
    """'/todos/{id}' → a regex whose groups are the path's parameters."""
    return re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>\\d+)", path) + "$")


COMPILED = [(method, compile_pattern(path), handler) for method, path, handler in ROUTES]


class Handler(BaseHTTPRequestHandler):
    def json(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            return json.loads(self.rfile.read(length) or b"null")
        except json.JSONDecodeError:
            return None

    def dispatch(self):
        for method, pattern, handler in COMPILED:
            match = pattern.match(self.path)
            if match and method == self.command:
                return handler(self, **match.groupdict())
        return 404, {"error": "not found"}

    def respond(self):
        status, payload = self.dispatch()
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        if payload is not None:
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = respond


port = int(os.environ["PORT"])
print(f"listening on {port}")
HTTPServer((os.environ.get("HOST", "127.0.0.1"), port), Handler).serve_forever()
