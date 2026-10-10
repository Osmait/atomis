// A REST API for a todo list, on axum: the same endpoints as the
// standard-library version, with the router, the parsing and the
// serialization done by the framework (axum, tokio, serde, serde_json).
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize)]
struct Todo {
    id: u64,
    title: String,
    done: bool,
}

#[derive(Debug, Default)]
struct Store {
    // A BTreeMap keeps its keys sorted, and ids only grow: creation order.
    todos: BTreeMap<u64, Todo>,
    next_id: u64,
}

// Handlers run on many threads at once, so the store sits behind a lock.
type Db = Arc<Mutex<Store>>;

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
}

/// The body as JSON, or None. Taking raw bytes instead of axum's `Json`
/// extractor lets a bad body get our own 400 rather than axum's rejection.
fn parse(body: &[u8]) -> Option<Value> {
    serde_json::from_slice(body).ok()
}

/// "/todos/7" → Some(7); "/todos/abc" → None, which answers 404.
fn todo_id(raw: &str) -> Option<u64> {
    raw.parse().ok()
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn list(State(db): State<Db>) -> Json<Vec<Todo>> {
    let store = db.lock().unwrap();
    Json(store.todos.values().cloned().collect())
}

async fn create(State(db): State<Db>, body: Bytes) -> Response {
    let data = parse(&body);
    let title = data.as_ref().and_then(|data| data.get("title")).and_then(Value::as_str);
    let title = match title {
        Some(title) if !title.is_empty() => title.to_string(),
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "title is required" }))).into_response(),
    };
    let mut store = db.lock().unwrap();
    store.next_id += 1;
    let todo = Todo { id: store.next_id, title, done: false };
    store.todos.insert(todo.id, todo.clone());
    (StatusCode::CREATED, Json(todo)).into_response()
}

async fn read(State(db): State<Db>, Path(raw): Path<String>) -> Response {
    let store = db.lock().unwrap();
    match todo_id(&raw).and_then(|id| store.todos.get(&id)) {
        Some(todo) => Json(todo.clone()).into_response(),
        None => not_found(),
    }
}

async fn update(State(db): State<Db>, Path(raw): Path<String>, body: Bytes) -> Response {
    let mut store = db.lock().unwrap();
    let todo = match todo_id(&raw).and_then(|id| store.todos.get_mut(&id)) {
        Some(todo) => todo,
        None => return not_found(),
    };
    // Only a boolean "done" changes the todo; anything else leaves it be.
    let data = parse(&body);
    if let Some(done) = data.as_ref().and_then(|data| data.get("done")).and_then(Value::as_bool) {
        todo.done = done;
    }
    Json(todo.clone()).into_response()
}

async fn remove(State(db): State<Db>, Path(raw): Path<String>) -> Response {
    let mut store = db.lock().unwrap();
    match todo_id(&raw).and_then(|id| store.todos.remove(&id)) {
        Some(_) => StatusCode::NO_CONTENT.into_response(),
        None => not_found(),
    }
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").expect("PORT is not set");
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let db: Db = Arc::new(Mutex::new(Store::default()));

    let app = Router::new()
        .route("/health", get(health))
        .route("/todos", get(list).post(create))
        .route("/todos/{id}", get(read).patch(update).delete(remove))
        .fallback(|| async { not_found() })
        .with_state(db);

    let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await.expect("cannot listen");
    println!("listening on {port}");
    axum::serve(listener, app).await.expect("server failed");
}
