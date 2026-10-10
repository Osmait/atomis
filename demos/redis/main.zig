// A mini Redis: an in-memory key-value store that logs every write to a
// file, and replays (then compacts) that log the next time it starts.
// Press Run and type commands under the output: SET name Ada, GET name,
// INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
// Run it again: the data is still there. Auto Run replays the Input text.
const std = @import("std");

const log_path = "../redis.aof"; // beside src/, so it is not one of your project files
const commands = [_][]const u8{ "SET", "GET", "DEL", "EXISTS", "INCR", "KEYS", "DBSIZE", "FLUSHALL" };

const Store = std.StringHashMapUnmanaged([]const u8);

const Db = struct {
    store: Store = .empty,
    log: std.Io.File,
    io: std.Io,
    allocator: std.mem.Allocator,

    fn append(db: *Db, comptime format: []const u8, args: anytype) !void {
        const entry = try std.fmt.allocPrint(db.allocator, format ++ "\n", args);
        try db.log.writeStreamingAll(db.io, entry);
    }

    fn put(db: *Db, key: []const u8, value: []const u8) !void {
        try db.store.put(db.allocator, try db.allocator.dupe(u8, key), try db.allocator.dupe(u8, value));
    }

    /// The keys in order: KEYS and compaction both list them sorted.
    fn sortedKeys(db: *Db) ![][]const u8 {
        const keys = try db.allocator.alloc([]const u8, db.store.count());
        var iterator = db.store.keyIterator();
        var i: usize = 0;
        while (iterator.next()) |key| : (i += 1) keys[i] = key.*;
        std.mem.sort([]const u8, keys, {}, lessThan);
        return keys;
    }

    fn execute(db: *Db, words: []const []const u8) !void {
        const command = try std.ascii.allocUpperString(db.allocator, words[0]);
        const args = words[1..];
        if (std.mem.eql(u8, command, "SET") and args.len >= 2) {
            const value = try std.mem.join(db.allocator, " ", args[1..]);
            try db.put(args[0], value);
            try db.append("SET {s} {s}", .{ args[0], value });
            std.debug.print("OK\n", .{});
        } else if (std.mem.eql(u8, command, "GET") and args.len == 1) {
            if (db.store.get(args[0])) |value| {
                std.debug.print("\"{s}\"\n", .{value});
            } else std.debug.print("(nil)\n", .{});
        } else if (std.mem.eql(u8, command, "DEL") and args.len == 1) {
            if (!db.store.remove(args[0])) {
                std.debug.print("(integer) 0\n", .{});
                return;
            }
            try db.append("DEL {s}", .{args[0]});
            std.debug.print("(integer) 1\n", .{});
        } else if (std.mem.eql(u8, command, "EXISTS") and args.len == 1) {
            std.debug.print("(integer) {d}\n", .{@intFromBool(db.store.contains(args[0]))});
        } else if (std.mem.eql(u8, command, "INCR") and args.len == 1) {
            const current = db.store.get(args[0]) orelse "0";
            const parsed = std.fmt.parseInt(i64, current, 10) catch null;
            const number = if (parsed) |n| std.math.add(i64, n, 1) catch null else null;
            const next = number orelse {
                std.debug.print("(error) ERR value is not an integer or out of range\n", .{});
                return;
            };
            try db.put(args[0], try std.fmt.allocPrint(db.allocator, "{d}", .{next}));
            try db.append("SET {s} {d}", .{ args[0], next });
            std.debug.print("(integer) {d}\n", .{next});
        } else if (std.mem.eql(u8, command, "KEYS") and args.len <= 1) {
            const keys = try db.sortedKeys();
            if (keys.len == 0) std.debug.print("(empty array)\n", .{});
            for (keys, 1..) |key, i| std.debug.print("{d}) \"{s}\"\n", .{ i, key });
        } else if (std.mem.eql(u8, command, "DBSIZE") and args.len == 0) {
            std.debug.print("(integer) {d}\n", .{db.store.count()});
        } else if (std.mem.eql(u8, command, "FLUSHALL") and args.len == 0) {
            db.store.clearRetainingCapacity();
            try db.append("FLUSHALL", .{});
            std.debug.print("OK\n", .{});
        } else if (isCommand(command)) {
            const lower = try std.ascii.allocLowerString(db.allocator, words[0]);
            std.debug.print("(error) ERR wrong number of arguments for '{s}'\n", .{lower});
        } else {
            std.debug.print("(error) ERR unknown command '{s}'\n", .{words[0]});
        }
    }
};

fn lessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

fn isCommand(command: []const u8) bool {
    for (commands) |known| {
        if (std.mem.eql(u8, command, known)) return true;
    }
    return false;
}

/// Rebuilds the store from the log: the cache starts as the file left it.
fn replay(db: *Db, text: []const u8) !usize {
    var entries: usize = 0;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        entries += 1;
        const space = std.mem.indexOfScalar(u8, line, ' ') orelse line.len;
        const op = line[0..space];
        const rest = if (space < line.len) line[space + 1 ..] else "";
        if (std.mem.eql(u8, op, "SET")) {
            const gap = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
            try db.put(rest[0..gap], if (gap < rest.len) rest[gap + 1 ..] else "");
        } else if (std.mem.eql(u8, op, "DEL")) {
            _ = db.store.remove(rest);
        } else if (std.mem.eql(u8, op, "FLUSHALL")) {
            db.store.clearRetainingCapacity();
        }
    }
    return entries;
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const io = init.io;
    const cwd = std.Io.Dir.cwd();

    const previous = cwd.readFileAlloc(io, log_path, allocator, .limited(1 << 20)) catch |err| switch (err) {
        error.FileNotFound => "",
        else => return err,
    };
    // Compaction: the log restarts as one SET per key, then grows a line per write.
    var db: Db = .{ .log = undefined, .io = io, .allocator = allocator };
    const entries = try replay(&db, previous);
    std.debug.print("loaded {d} keys ({d} log entries) from redis.aof\n", .{ db.store.count(), entries });
    db.log = try cwd.createFile(io, log_path, .{});
    defer db.log.close(io);
    for (try db.sortedKeys()) |key| try db.append("SET {s} {s}", .{ key, db.store.get(key).? });

    var buffer: [512]u8 = undefined;
    var stdin = std.Io.File.stdin().readerStreaming(io, &buffer);
    std.debug.print("mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT\n", .{});
    while (true) {
        std.debug.print("redis> ", .{});
        const line = (stdin.interface.takeDelimiter('\n') catch break) orelse break;
        var tokens = std.mem.tokenizeAny(u8, line, " \t\r");
        var words: std.ArrayList([]const u8) = .empty;
        while (tokens.next()) |word| try words.append(allocator, word);
        if (words.items.len == 0) continue;
        if (std.ascii.eqlIgnoreCase(words.items[0], "QUIT")) break;
        try db.execute(words.items);
    }
    std.debug.print("bye\n", .{});
}
