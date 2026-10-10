// A REST API for a todo list, on the standard library alone: no framework,
// so the HTTP parsing and the JSON are written out here, small and plain.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

#[derive(Debug)]
struct Todo {
    id: u64,
    title: String,
    done: bool,
}

/// A request as it comes off the wire: `POST /todos HTTP/1.1`, headers, body.
#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

/// What a handler answers: a status and, unless it is 204, a JSON body.
#[derive(Debug)]
struct Response {
    status: u16,
    body: Option<String>,
}

fn json(status: u16, body: String) -> Response {
    Response { status, body: Some(body) }
}

fn error(status: u16, message: &str) -> Response {
    json(status, format!("{{\"error\":{}}}", quote(message)))
}

// ---------------------------------------------------------------- HTTP ----

/// Reads one request: the request line, the headers up to the blank line,
/// then exactly Content-Length bytes of body. None if the client hung up.
fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut length = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break; // the blank line: headers are over, the body follows
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok()?;
            }
        }
    }

    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request { method, path, body })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "",
    }
}

/// Writes the status line, the headers and the body, then the connection
/// closes: one request per connection keeps the server simple.
fn write_response(mut stream: &TcpStream, response: Response) {
    let body = response.body.unwrap_or_default();
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, reason(response.status));
    if response.status != 204 {
        head.push_str("Content-Type: application/json\r\n");
    }
    head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

// ---------------------------------------------------------------- JSON ----

/// Just enough JSON to read a request body: every value, kept as parsed.
#[allow(dead_code)] // the parser keeps every value; the API reads only two
#[derive(Debug)]
enum Json {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(fields) => fields.iter().find(|field| field.0 == key).map(|field| &field.1),
            _ => None,
        }
    }
}

/// A recursive-descent parser over the bytes: one function per kind of value.
#[derive(Debug)]
struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn parse(text: &[u8]) -> Option<Json> {
        let mut parser = Parser { bytes: text, at: 0 };
        let value = parser.value()?;
        parser.skip_space();
        if parser.at == parser.bytes.len() { Some(value) } else { None }
    }

    fn skip_space(&mut self) {
        while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_space();
        self.bytes.get(self.at).copied()
    }

    fn expect(&mut self, word: &str) -> Option<()> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Some(())
        } else {
            None
        }
    }

    fn value(&mut self) -> Option<Json> {
        match self.peek()? {
            b'n' => self.expect("null").map(|_| Json::Null),
            b't' => self.expect("true").map(|_| Json::Bool(true)),
            b'f' => self.expect("false").map(|_| Json::Bool(false)),
            b'"' => self.string().map(Json::Text),
            b'[' => self.list(),
            b'{' => self.object(),
            _ => self.number(),
        }
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.at;
        while self.at < self.bytes.len() && b"+-.eE0123456789".contains(&self.bytes[self.at]) {
            self.at += 1;
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).ok()?;
        text.parse().ok().map(Json::Number)
    }

    fn string(&mut self) -> Option<String> {
        self.at += 1; // the opening quote
        let mut out = Vec::new();
        loop {
            let byte = *self.bytes.get(self.at)?;
            self.at += 1;
            match byte {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let escape = *self.bytes.get(self.at)?;
                    self.at += 1;
                    let decoded = match escape {
                        b'n' => '\n',
                        b't' => '\t',
                        b'r' => '\r',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'u' => {
                            let hex = std::str::from_utf8(self.bytes.get(self.at..self.at + 4)?).ok()?;
                            self.at += 4;
                            char::from_u32(u32::from_str_radix(hex, 16).ok()?).unwrap_or('\u{fffd}')
                        }
                        other => other as char, // \" \\ \/
                    };
                    let mut buffer = [0; 4];
                    out.extend_from_slice(decoded.encode_utf8(&mut buffer).as_bytes());
                }
                _ => out.push(byte),
            }
        }
    }

    fn list(&mut self) -> Option<Json> {
        self.at += 1; // [
        let mut items = Vec::new();
        if self.peek()? == b']' {
            self.at += 1;
            return Some(Json::List(items));
        }
        loop {
            items.push(self.value()?);
            match self.peek()? {
                b',' => self.at += 1,
                b']' => {
                    self.at += 1;
                    return Some(Json::List(items));
                }
                _ => return None,
            }
        }
    }

    fn object(&mut self) -> Option<Json> {
        self.at += 1; // {
        let mut fields = Vec::new();
        if self.peek()? == b'}' {
            self.at += 1;
            return Some(Json::Object(fields));
        }
        loop {
            if self.peek()? != b'"' {
                return None;
            }
            let key = self.string()?;
            if self.peek()? != b':' {
                return None;
            }
            self.at += 1;
            let value = self.value()?;
            fields.push((key, value));
            match self.peek()? {
                b',' => self.at += 1,
                b'}' => {
                    self.at += 1;
                    return Some(Json::Object(fields));
                }
                _ => return None,
            }
        }
    }
}

/// A Rust string as a JSON string literal, quotes and escapes included.
fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn todo_json(todo: &Todo) -> String {
    format!("{{\"id\":{},\"title\":{},\"done\":{}}}", todo.id, quote(&todo.title), todo.done)
}

// ---------------------------------------------------------------- API -----

#[derive(Debug)]
struct App {
    // A BTreeMap keeps its keys sorted, and ids only grow: creation order.
    todos: BTreeMap<u64, Todo>,
    next_id: u64,
}

/// A handler gets the app, the request and the id its route captured.
type Handler = fn(&mut App, &Request, Option<u64>) -> Response;

/// The route table: what a framework builds from `.get("/todos", …)` calls.
/// "{id}" in a path matches one numeric segment and hands it to the handler.
const ROUTES: &[(&str, &str, Handler)] = &[
    ("GET", "/health", health),
    ("GET", "/todos", list_todos),
    ("POST", "/todos", create_todo),
    ("GET", "/todos/{id}", get_todo),
    ("PATCH", "/todos/{id}", update_todo),
    ("DELETE", "/todos/{id}", delete_todo),
];

/// Matches a path against a route's pattern, segment by segment.
/// "/todos/{id}" against "/todos/7" → Some(Some(7)); against "/todos/abc"
/// or "/todos" → None; "/health" against "/health" → Some(None).
fn match_path(pattern: &str, path: &str) -> Option<Option<u64>> {
    let wanted: Vec<&str> = pattern.split('/').collect();
    let given: Vec<&str> = path.split('/').collect();
    if wanted.len() != given.len() {
        return None;
    }
    let mut id = None;
    for (want, got) in wanted.iter().zip(given.iter()) {
        if *want == "{id}" {
            id = Some(got.parse::<u64>().ok()?);
        } else if want != got {
            return None;
        }
    }
    Some(id)
}

/// The router: the first route whose method and path match answers.
fn route(app: &mut App, request: &Request) -> Response {
    for (method, pattern, handler) in ROUTES {
        if *method != request.method {
            continue;
        }
        if let Some(id) = match_path(pattern, &request.path) {
            return handler(app, request, id);
        }
    }
    error(404, "not found")
}

fn health(_: &mut App, _: &Request, _: Option<u64>) -> Response {
    json(200, "{\"ok\":true}".to_string())
}

fn list_todos(app: &mut App, _: &Request, _: Option<u64>) -> Response {
    let items: Vec<String> = app.todos.values().map(todo_json).collect();
    json(200, format!("[{}]", items.join(",")))
}

fn create_todo(app: &mut App, request: &Request, _: Option<u64>) -> Response {
    let data = Parser::parse(&request.body);
    let title = match data.as_ref().and_then(|data| data.get("title")) {
        Some(Json::Text(title)) if !title.is_empty() => title.clone(),
        _ => return error(400, "title is required"),
    };
    let todo = Todo { id: app.next_id, title, done: false };
    let answer = json(201, todo_json(&todo));
    app.todos.insert(todo.id, todo);
    app.next_id += 1;
    answer
}

fn get_todo(app: &mut App, _: &Request, id: Option<u64>) -> Response {
    match id.and_then(|id| app.todos.get(&id)) {
        Some(todo) => json(200, todo_json(todo)),
        None => error(404, "not found"),
    }
}

fn update_todo(app: &mut App, request: &Request, id: Option<u64>) -> Response {
    let todo = match id.and_then(|id| app.todos.get_mut(&id)) {
        Some(todo) => todo,
        None => return error(404, "not found"),
    };
    // Only a boolean "done" changes the todo; anything else leaves it be.
    let data = Parser::parse(&request.body);
    if let Some(Json::Bool(done)) = data.as_ref().and_then(|data| data.get("done")) {
        todo.done = *done;
    }
    json(200, todo_json(todo))
}

fn delete_todo(app: &mut App, _: &Request, id: Option<u64>) -> Response {
    match id.and_then(|id| app.todos.remove(&id)) {
        Some(_) => Response { status: 204, body: None },
        None => error(404, "not found"),
    }
}

fn main() {
    let port = std::env::var("PORT").expect("PORT is not set");
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let listener = TcpListener::bind(format!("{host}:{port}")).expect("cannot listen");
    println!("listening on {port}");

    let mut app = App { todos: BTreeMap::new(), next_id: 1 };
    // One connection at a time: accept, read a request, answer, close.
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(_) => continue,
        };
        if let Some(request) = read_request(&stream) {
            let response = route(&mut app, &request);
            println!("{} {} → {}", request.method, request.path, response.status);
            write_response(&stream, response);
        }
    }
}
