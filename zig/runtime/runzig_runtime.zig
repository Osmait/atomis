const std = @import("std");

pub const ProbeMeta = struct {
    line: u32,
    column: u32,
    name: []const u8,
};

pub const LogMeta = struct {
    file_id: u32,
    line: u32,
    column: u32,
};

pub const LogLoopMeta = struct {
    file_id: u32,
    line: u32,
    column: u32,
    loop_line: u32,
    loop_column: u32,
    loop_name: []const u8,
};

const MAX_PREVIEW = 4096;
const MAX_EVENT = 64 * 1024;
var lock: std.atomic.Mutex = .unlocked;
var sequence: std.atomic.Value(u64) = .init(0);

extern "c" fn write(fd: c_int, buffer: [*]const u8, count: usize) isize;

fn writeAllFd(fd: c_int, bytes: []const u8) void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const result = write(fd, bytes.ptr + offset, bytes.len - offset);
        if (result <= 0) return;
        offset += @intCast(result);
    }
}

fn writeAllFd3(bytes: []const u8) void {
    writeAllFd(3, bytes);
}

pub inline fn logSource(comptime meta: LogMeta) void {
    var marker_buffer: [96]u8 = undefined;
    var marker_writer: std.Io.Writer = .fixed(&marker_buffer);
    marker_writer.print("\x1eZIGLIVE_LOG:{d}:{d}:{d}\x1f", .{ meta.file_id, meta.line, meta.column }) catch return;
    writeAllFd(2, marker_writer.buffered());
}

fn appendJsonString(writer: *std.Io.Writer, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |byte| switch (byte) {
        '"' => try writer.writeAll("\\\""),
        '\\' => try writer.writeAll("\\\\"),
        '\n' => try writer.writeAll("\\n"),
        '\r' => try writer.writeAll("\\r"),
        '\t' => try writer.writeAll("\\t"),
        0...8, 11...12, 14...0x1f => try writer.print("\\u00{x:0>2}", .{byte}),
        else => try writer.writeByte(byte),
    };
    try writer.writeByte('"');
}

fn renderPreview(writer: *std.Io.Writer, value_ptr: anytype) !void {
    const T = @TypeOf(value_ptr.*);
    switch (@typeInfo(T)) {
        .type, .void, .noreturn, .frame, .@"anyframe", .@"fn", .@"opaque", .undefined, .null, .enum_literal => try writer.print("<unavailable: {s}>", .{@typeName(T)}),
        .pointer => |pointer| switch (pointer.size) {
            // String literals are `*const [N:0]u8`: show the text, not the
            // address. Other pointers-to-array preview their pointee too.
            .one => switch (@typeInfo(pointer.child)) {
                .array => |array| {
                    if (array.child == u8) {
                        try appendJsonString(writer, value_ptr.*.*[0..]);
                    } else try writer.print("{any}", .{value_ptr.*.*});
                },
                else => try writer.print("0x{x}", .{@intFromPtr(value_ptr.*)}),
            },
            .many, .c => try writer.print("0x{x}", .{@intFromPtr(value_ptr.*)}),
            .slice => {
                const value = value_ptr.*;
                if (pointer.child == u8) {
                    const shown = value[0..@min(value.len, 512)];
                    try appendJsonString(writer, shown);
                    if (shown.len != value.len) try writer.writeAll("…");
                } else {
                    const shown = value[0..@min(value.len, 32)];
                    try writer.print("{any}", .{shown});
                    if (shown.len != value.len) try writer.writeAll("…");
                }
            },
        },
        .array => |array| {
            if (array.child == u8) {
                try appendJsonString(writer, value_ptr.*[0..]);
            } else try writer.print("{any}", .{value_ptr.*});
        },
        else => try writer.print("{any}", .{value_ptr.*}),
    }
}

pub inline fn logSourceLoop(comptime meta: LogLoopMeta, value: anytype) void {
    switch (@typeInfo(@TypeOf(value))) {
        .comptime_int => {
            const materialized: i128 = value;
            emitLogSourceLoop(meta, &materialized);
        },
        .comptime_float => {
            const materialized: f128 = value;
            emitLogSourceLoop(meta, &materialized);
        },
        else => {
            const materialized = value;
            emitLogSourceLoop(meta, &materialized);
        },
    }
}

inline fn emitLogSourceLoop(comptime meta: LogLoopMeta, value_ptr: anytype) void {
    var value_buffer: [MAX_PREVIEW]u8 = undefined;
    var value_writer: std.Io.Writer = .fixed(&value_buffer);
    renderPreview(&value_writer, value_ptr) catch {
        value_writer = .fixed(&value_buffer);
        value_writer.writeAll("<preview unavailable>") catch return;
    };

    var marker_buffer: [MAX_PREVIEW + 256]u8 = undefined;
    var marker_writer: std.Io.Writer = .fixed(&marker_buffer);
    marker_writer.print("\x1eZIGLIVE_LOG:{d}:{d}:{d}:{d}:{d}:{s}:", .{
        meta.file_id,
        meta.line,
        meta.column,
        meta.loop_line,
        meta.loop_column,
        meta.loop_name,
    }) catch return;
    marker_writer.writeAll(value_writer.buffered()) catch return;
    marker_writer.writeByte('\x1f') catch return;

    while (!lock.tryLock()) std.atomic.spinLoopHint();
    defer lock.unlock();
    writeAllFd(2, marker_writer.buffered());
}

pub inline fn probe(comptime probe_id: []const u8, value: anytype, comptime meta: ProbeMeta) void {
    switch (@typeInfo(@TypeOf(value))) {
        .comptime_int => {
            const materialized: i128 = value;
            emit(probe_id, &materialized, meta);
        },
        .comptime_float => {
            const materialized: f128 = value;
            emit(probe_id, &materialized, meta);
        },
        else => {
            const materialized = value;
            emit(probe_id, &materialized, meta);
        },
    }
}

/// Appends the optional low-level layout fields (bits/sizeBytes/alignBytes
/// and struct field offsets) that power the editor's peek panel. All type
/// facts are comptime; only the field previews render at runtime.
fn appendLayout(event_writer: *std.Io.Writer, value_ptr: anytype) !void {
    const T = @TypeOf(value_ptr.*);
    switch (@typeInfo(T)) {
        .int => try event_writer.print(",\"bits\":{d}", .{@bitSizeOf(T)}),
        .bool => try event_writer.writeAll(",\"bits\":1"),
        else => {},
    }
    switch (@typeInfo(T)) {
        .int, .float, .bool, .@"struct", .array, .@"enum", .optional, .pointer, .vector, .@"union" => {
            try event_writer.print(",\"sizeBytes\":{d},\"alignBytes\":{d}", .{ @sizeOf(T), @alignOf(T) });
        },
        else => {},
    }
    switch (@typeInfo(T)) {
        .@"struct" => |structure| if (structure.layout != .@"packed" and !structure.is_tuple and structure.fields.len > 0 and structure.fields.len <= 12) {
            try event_writer.writeAll(",\"fields\":[");
            comptime var first = true;
            inline for (structure.fields) |field| {
                if (!field.is_comptime) {
                    if (!first) try event_writer.writeByte(',');
                    first = false;
                    try event_writer.writeAll("{\"name\":");
                    try appendJsonString(event_writer, field.name);
                    try event_writer.writeAll(",\"typeName\":");
                    try appendJsonString(event_writer, @typeName(field.type));
                    try event_writer.print(",\"offset\":{d},\"size\":{d},\"preview\":", .{ @offsetOf(T, field.name), @sizeOf(field.type) });
                    var field_buffer: [256]u8 = undefined;
                    var field_writer: std.Io.Writer = .fixed(field_buffer[0 .. field_buffer.len - 8]);
                    renderPreview(&field_writer, &@field(value_ptr.*, field.name)) catch {};
                    try appendJsonString(event_writer, field_writer.buffered());
                    try event_writer.writeByte('}');
                }
            }
            try event_writer.writeAll("]");
        },
        else => {},
    }
}

inline fn emit(comptime probe_id: []const u8, value_ptr: anytype, comptime meta: ProbeMeta) void {
    var preview_buffer: [MAX_PREVIEW]u8 = undefined;
    var preview_writer: std.Io.Writer = .fixed(preview_buffer[0 .. MAX_PREVIEW - 8]);
    var truncated = false;
    renderPreview(&preview_writer, value_ptr) catch {
        truncated = true;
    };
    const preview = preview_writer.buffered();

    var event_buffer: [MAX_EVENT]u8 = undefined;
    var event_writer: std.Io.Writer = .fixed(&event_buffer);
    event_writer.writeAll("{\"protocolVersion\":1,\"kind\":\"probe_value\",\"probeId\":") catch return;
    appendJsonString(&event_writer, probe_id) catch return;
    event_writer.writeAll(",\"name\":") catch return;
    appendJsonString(&event_writer, meta.name) catch return;
    event_writer.print(",\"line\":{d},\"column\":{d},\"typeName\":", .{ meta.line, meta.column }) catch return;
    appendJsonString(&event_writer, @typeName(@TypeOf(value_ptr.*))) catch return;
    event_writer.writeAll(",\"preview\":") catch return;
    appendJsonString(&event_writer, preview) catch return;
    appendLayout(&event_writer, value_ptr) catch return;
    event_writer.print(",\"truncated\":{s},\"sequence\":{d}}}\n", .{
        if (truncated) "true" else "false",
        sequence.fetchAdd(1, .monotonic) + 1,
    }) catch return;

    while (!lock.tryLock()) std.atomic.spinLoopHint();
    defer lock.unlock();
    writeAllFd3(event_writer.buffered());
}

test "preview scalar and JSON escaping" {
    var value: i32 = -42;
    var buffer: [128]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try renderPreview(&writer, &value);
    try std.testing.expectEqualStrings("-42", writer.buffered());

    var json_buffer: [128]u8 = undefined;
    var json_writer: std.Io.Writer = .fixed(&json_buffer);
    try appendJsonString(&json_writer, "a\n\"b");
    try std.testing.expectEqualStrings("\"a\\n\\\"b\"", json_writer.buffered());
}

test "preview values" {
    const Choice = enum { first, second };
    const Tagged = union(enum) { number: i32, empty };
    var boolean = true;
    var signed: i32 = -7;
    var unsigned: u64 = 9;
    var float: f64 = 1.5;
    var choice: Choice = .second;
    var optional_null: ?u8 = null;
    var optional_value: ?u8 = 3;
    var error_success: anyerror!i32 = 4;
    var error_value: anyerror!i32 = error.TestFailure;
    var string: []const u8 = "hello";
    var array = [_]i16{ 1, 2, 3 };
    var slice: []i16 = &array;
    var structure = struct { x: i32, ok: bool }{ .x = 3, .ok = true };
    var tuple = .{ @as(i32, 2), true };
    var tagged: Tagged = .{ .number = 8 };
    var pointee: i32 = 11;
    var pointer: *i32 = &pointee;
    inline for (.{
        &boolean,        &signed,        &unsigned,    &float,   &choice, &optional_null,
        &optional_value, &error_success, &error_value, &string,  &array,  &slice,
        &structure,      &tuple,         &tagged,      &pointer,
    }) |value| {
        var buffer: [512]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&buffer);
        try renderPreview(&writer, value);
        try std.testing.expect(writer.buffered().len > 0);
    }
}

test "string literal pointers preview their text" {
    const text: *const [4:0]u8 = "hola";
    var buffer: [64]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try renderPreview(&writer, &text);
    try std.testing.expectEqualStrings("\"hola\"", writer.buffered());

    var numbers = [_]i16{ 1, 2 };
    const numbers_ptr: *const [2]i16 = &numbers;
    var array_writer: std.Io.Writer = .fixed(&buffer);
    try renderPreview(&array_writer, &numbers_ptr);
    try std.testing.expect(array_writer.buffered().len > 0);
}

test "layout metadata for ints and structs" {
    var flags: u8 = 43;
    var buffer: [512]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try appendLayout(&writer, &flags);
    try std.testing.expectEqualStrings(",\"bits\":8,\"sizeBytes\":1,\"alignBytes\":1", writer.buffered());

    const Pixel = extern struct { r: u8, g: u8, b: u8, a: u8 };
    var px: Pixel = .{ .r = 255, .g = 128, .b = 64, .a = 255 };
    var struct_buffer: [1024]u8 = undefined;
    var struct_writer: std.Io.Writer = .fixed(&struct_buffer);
    try appendLayout(&struct_writer, &px);
    const rendered = struct_writer.buffered();
    try std.testing.expect(std.mem.indexOf(u8, rendered, "\"sizeBytes\":4") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "{\"name\":\"g\",\"typeName\":\"u8\",\"offset\":1,\"size\":1,\"preview\":\"128\"}") != null);

    var tuple = .{ @as(i32, 2), true };
    var tuple_writer: std.Io.Writer = .fixed(&struct_buffer);
    try appendLayout(&tuple_writer, &tuple);
    try std.testing.expect(std.mem.indexOf(u8, tuple_writer.buffered(), "fields") == null);
}

test "preview truncates through bounded writer" {
    var large: [100]u32 = @splat(123456);
    var buffer: [32]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try std.testing.expectError(error.WriteFailed, renderPreview(&writer, &large));
}
