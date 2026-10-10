# A REST API for a todo list, on FastAPI served by uvicorn.
# Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
# call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
# GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
# The data lives in memory: an edit restarts the server, and it with it.
import os

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictStr

app = FastAPI()
todos = {}  # id -> todo; a dict keeps creation order
next_id = 1


class NewTodo(BaseModel):
    title: StrictStr = Field(min_length=1)


def not_found():
    return JSONResponse({"error": "not found"}, status_code=404)


# The only body FastAPI validates is POST /todos's, so any validation error
# (invalid JSON, not an object, a missing, empty or non-string title) is that
# one. FastAPI's own answer would be a 422 with its "detail" list.
@app.exception_handler(RequestValidationError)
async def bad_request(request, exc):
    return JSONResponse({"error": "title is required"}, status_code=400)


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/todos")
async def list_todos():
    return list(todos.values())


@app.post("/todos", status_code=201)
async def create_todo(new: NewTodo):
    global next_id
    todo = {"id": next_id, "title": new.title, "done": False}
    todos[next_id] = todo
    next_id += 1
    return todo


# {todo_id:int} rather than a validated int: /todos/abc is a 404, not a 400.
@app.get("/todos/{todo_id:int}")
async def get_todo(todo_id: int):
    return todos.get(todo_id) or not_found()


@app.patch("/todos/{todo_id:int}")
async def update_todo(todo_id: int, request: Request):
    todo = todos.get(todo_id)
    if todo is None:
        return not_found()
    # Read the body by hand: only a real boolean "done" changes the todo,
    # where a pydantic bool would also take "yes" or 1.
    try:
        data = await request.json()
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("done"), bool):
        todo["done"] = data["done"]
    return todo


@app.delete("/todos/{todo_id:int}")
async def delete_todo(todo_id: int):
    if todos.pop(todo_id, None) is None:
        return not_found()
    return Response(status_code=204)


uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ["PORT"]))
