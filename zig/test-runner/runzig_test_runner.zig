//! Custom test runner for ZigLive sessions. Runs every collected test
//! sequentially and reports NDJSON events on fd 3, mirroring the probe
//! channel protocol: test_start, test_result and a final test_summary.
const builtin = @import("builtin");
const std = @import("std");

extern "c" fn write(fd: c_int, buffer: [*]const u8, count: usize) isize;

fn writeAllFd3(bytes: []const u8) void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const result = write(3, bytes.ptr + offset, bytes.len - offset);
        if (result <= 0) return;
        offset += @intCast(result);
    }
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

const Status = enum { passed, failed, skipped, leaked };

fn emitStart(index: usize, name: []const u8) void {
    var buffer: [8192]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    writer.print("{{\"protocolVersion\":1,\"kind\":\"test_start\",\"index\":{d},\"name\":", .{index}) catch return;
    appendJsonString(&writer, name) catch return;
    writer.writeAll("}\n") catch return;
    writeAllFd3(writer.buffered());
}

fn emitResult(index: usize, name: []const u8, status: Status, error_name: ?[]const u8, duration_ns: u64) void {
    var buffer: [8192]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    writer.print("{{\"protocolVersion\":1,\"kind\":\"test_result\",\"index\":{d},\"status\":\"{s}\",\"durationNs\":{d},\"name\":", .{ index, @tagName(status), duration_ns }) catch return;
    appendJsonString(&writer, name) catch return;
    if (error_name) |detail| {
        writer.writeAll(",\"error\":") catch return;
        appendJsonString(&writer, detail) catch return;
    }
    writer.writeAll("}\n") catch return;
    writeAllFd3(writer.buffered());
}

pub fn main(init: std.process.Init) void {
    const io = init.io;
    var passed: u32 = 0;
    var failed: u32 = 0;
    var skipped: u32 = 0;
    var leaked: u32 = 0;
    for (builtin.test_functions, 0..) |test_fn, index| {
        emitStart(index, test_fn.name);
        std.testing.allocator_instance = .{};
        const started = std.Io.Timestamp.now(io, .awake);
        const result = test_fn.func();
        const finished = std.Io.Timestamp.now(io, .awake);
        const duration_ns: u64 = @intCast(@max(started.durationTo(finished).toNanoseconds(), 0));
        const leak = std.testing.allocator_instance.deinit() == .leak;
        if (result) |_| {
            if (leak) {
                leaked += 1;
                emitResult(index, test_fn.name, .leaked, "MemoryLeak", duration_ns);
            } else {
                passed += 1;
                emitResult(index, test_fn.name, .passed, null, duration_ns);
            }
        } else |err| if (err == error.SkipZigTest) {
            skipped += 1;
            emitResult(index, test_fn.name, .skipped, null, duration_ns);
        } else {
            failed += 1;
            emitResult(index, test_fn.name, .failed, @errorName(err), duration_ns);
        }
    }
    var buffer: [256]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    writer.print("{{\"protocolVersion\":1,\"kind\":\"test_summary\",\"passed\":{d},\"failed\":{d},\"skipped\":{d},\"leaked\":{d}}}\n", .{ passed, failed, skipped, leaked }) catch return;
    writeAllFd3(writer.buffered());
    if (failed != 0 or leaked != 0) std.process.exit(1);
}
