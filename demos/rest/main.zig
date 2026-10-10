// A REST API for a todo list, on the standard library alone.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
const std = @import("std");
const http = std.http;

const Todo = struct {
    id: u32,
    title: []const u8,
    done: bool = false,
};

/// What a handler answers: a status and, unless it is null, a JSON body.
const Reply = struct {
    status: http.Status,
    body: ?[]const u8 = null,
};

/// What a handler gets: the id a "{id}" in its path captured, and the body.
const Params = struct {
    id: u32 = 0,
    body: []const u8,
};

const Handler = *const fn (api: *Api, params: Params) anyerror!Reply;

const Route = struct {
    method: []const u8,
    path: []const u8,
    handler: Handler,
};

// The router: the first route whose method and path match handles the request.
const routes = [_]Route{
    .{ .method = "GET", .path = "/health", .handler = health },
    .{ .method = "GET", .path = "/todos", .handler = listTodos },
    .{ .method = "POST", .path = "/todos", .handler = createTodo },
    .{ .method = "GET", .path = "/todos/{id}", .handler = getTodo },
    .{ .method = "PATCH", .path = "/todos/{id}", .handler = updateTodo },
    .{ .method = "DELETE", .path = "/todos/{id}", .handler = deleteTodo },
};

/// Matches a path against a pattern segment by segment; "{id}" captures a number.
fn match(pattern: []const u8, path: []const u8) ?Params {
    var params: Params = .{ .body = "" };
    var wanted = std.mem.splitScalar(u8, pattern, '/');
    var given = std.mem.splitScalar(u8, path, '/');
    while (wanted.next()) |segment| {
        const actual = given.next() orelse return null;
        if (std.mem.eql(u8, segment, "{id}")) {
            params.id = std.fmt.parseInt(u32, actual, 10) catch return null;
        } else if (!std.mem.eql(u8, segment, actual)) return null;
    }
    if (given.next() != null) return null; // the path is longer than the pattern
    return params;
}

const Api = struct {
    todos: std.ArrayList(Todo) = .empty, // in creation order
    next_id: u32 = 1,
    /// Lives as long as the server: the todos and their titles.
    gpa: std.mem.Allocator,
    /// Freed after every request: parsed bodies and rendered JSON.
    scratch: std.mem.Allocator,

    fn json(api: *Api, status: http.Status, payload: anytype) !Reply {
        return .{ .status = status, .body = try std.json.Stringify.valueAlloc(api.scratch, payload, .{}) };
    }

    fn notFound(api: *Api) !Reply {
        return api.json(.not_found, .{ .@"error" = "not found" });
    }

    /// The body as JSON, or null when it is empty or not JSON at all.
    fn readJson(api: *Api, body: []const u8) ?std.json.Value {
        return std.json.parseFromSliceLeaky(std.json.Value, api.scratch, body, .{}) catch null;
    }

    /// Where the todo with this id sits in the list, if it exists.
    fn find(api: *Api, id: u32) ?usize {
        for (api.todos.items, 0..) |todo, index| {
            if (todo.id == id) return index;
        }
        return null;
    }

    /// Runs the first route that matches, or answers 404.
    fn dispatch(api: *Api, method: []const u8, path: []const u8, body: []const u8) !Reply {
        for (routes) |route| {
            if (!std.mem.eql(u8, route.method, method)) continue;
            var params = match(route.path, path) orelse continue;
            params.body = body;
            return route.handler(api, params);
        }
        return api.notFound();
    }
};

fn health(api: *Api, _: Params) !Reply {
    return api.json(.ok, .{ .ok = true });
}

fn listTodos(api: *Api, _: Params) !Reply {
    return api.json(.ok, api.todos.items);
}

fn createTodo(api: *Api, params: Params) !Reply {
    const required = .{ .@"error" = "title is required" };
    const data = api.readJson(params.body) orelse return api.json(.bad_request, required);
    if (data != .object) return api.json(.bad_request, required);
    const title = data.object.get("title") orelse return api.json(.bad_request, required);
    if (title != .string or title.string.len == 0) return api.json(.bad_request, required);

    const todo: Todo = .{ .id = api.next_id, .title = try api.gpa.dupe(u8, title.string) };
    try api.todos.append(api.gpa, todo);
    api.next_id += 1;
    return api.json(.created, todo);
}

fn getTodo(api: *Api, params: Params) !Reply {
    const index = api.find(params.id) orelse return api.notFound();
    return api.json(.ok, api.todos.items[index]);
}

fn updateTodo(api: *Api, params: Params) !Reply {
    const index = api.find(params.id) orelse return api.notFound();
    const todo = &api.todos.items[index];
    // Only a boolean "done" changes it; anything else leaves it as it was.
    if (api.readJson(params.body)) |data| if (data == .object) {
        if (data.object.get("done")) |done| if (done == .bool) {
            todo.done = done.bool;
        };
    };
    return api.json(.ok, todo.*);
}

fn deleteTodo(api: *Api, params: Params) !Reply {
    const index = api.find(params.id) orelse return api.notFound();
    const removed = api.todos.orderedRemove(index);
    api.gpa.free(removed.title);
    return .{ .status = .no_content };
}

/// Answers one request on a fresh connection, then closes it.
fn serve(api: *Api, io: std.Io, stream: std.Io.net.Stream) !void {
    defer stream.close(io);
    var recv_buffer: [8192]u8 = undefined;
    var send_buffer: [8192]u8 = undefined;
    var connection_reader = stream.reader(io, &recv_buffer);
    var connection_writer = stream.writer(io, &send_buffer);
    var server: http.Server = .init(&connection_reader.interface, &connection_writer.interface);

    var request = try server.receiveHead();
    const method = @tagName(request.head.method);
    // Reading the body reuses the header's memory, so keep a copy of the path.
    const path = try api.scratch.dupe(u8, request.head.target);
    // No content-length and not chunked: no body (else the reader waits for EOF).
    const has_body = request.head.content_length != null or request.head.transfer_encoding == .chunked;
    var body_buffer: [1024]u8 = undefined;
    const body = if (has_body)
        try (try request.readerExpectContinue(&body_buffer)).allocRemaining(api.scratch, .limited(64 * 1024))
    else
        "";

    const reply = try api.dispatch(method, path, body);
    std.debug.print("{s} {s} -> {d}\n", .{ method, path, @intFromEnum(reply.status) });
    const json_header: []const http.Header = &.{.{ .name = "content-type", .value = "application/json" }};
    try request.respond(reply.body orelse "", .{
        .status = reply.status,
        .keep_alive = false,
        .extra_headers = if (reply.body != null) json_header else &.{},
    });
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const port_text = init.environ_map.get("PORT") orelse {
        std.debug.print("set PORT to the port to listen on\n", .{});
        return;
    };
    const port = try std.fmt.parseInt(u16, port_text, 10);
    const host = init.environ_map.get("HOST") orelse "127.0.0.1";

    var scratch = std.heap.ArenaAllocator.init(init.gpa);
    var api: Api = .{ .gpa = init.gpa, .scratch = scratch.allocator() };

    const address = try std.Io.net.IpAddress.parse(host, port);
    var listener = try address.listen(io, .{ .reuse_address = true });
    std.debug.print("listening on {d}\n", .{port});
    while (true) {
        const stream = listener.accept(io) catch |err| {
            std.debug.print("accept failed: {t}\n", .{err});
            continue;
        };
        serve(&api, io, stream) catch |err| std.debug.print("request failed: {t}\n", .{err});
        _ = scratch.reset(.retain_capacity);
    }
}
