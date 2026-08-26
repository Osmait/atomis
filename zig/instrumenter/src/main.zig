const std = @import("std");
const AstAdapter = @import("AstAdapter.zig");

const Options = struct {
    input: ?[]const u8 = null,
    output: ?[]const u8 = null,
    source_map: ?[]const u8 = null,
    uri: []const u8 = "file:///main.zig",
    version: u64 = 1,
    auto_inspect: bool = true,
    manual_ids: std.ArrayList([]const u8) = .empty,
};

fn jsonString(writer: *std.Io.Writer, value: []const u8) !void {
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

fn renderResult(writer: *std.Io.Writer, result: AstAdapter.Result, options: Options) !void {
    try writer.print("{{\"protocolVersion\":1,\"documentVersion\":{d}", .{options.version});
    if (result.generated != null) {
        try writer.writeAll(",\"generatedPath\":");
        try jsonString(writer, options.output.?);
        try writer.writeAll(",\"sourceMapPath\":");
        try jsonString(writer, options.source_map.?);
    }
    try writer.writeAll(",\"probes\":[");
    for (result.probes, 0..) |probe, index| {
        if (index != 0) try writer.writeByte(',');
        try writer.writeAll("{\"probeId\":");
        try jsonString(writer, &probe.probe_id);
        try writer.writeAll(",\"name\":");
        try jsonString(writer, probe.name);
        try writer.print(",\"supported\":{s}", .{if (probe.supported) "true" else "false"});
        if (probe.reason) |reason| {
            try writer.writeAll(",\"reason\":");
            try jsonString(writer, reason);
        }
        try writer.print(",\"originalRange\":{{\"startLine\":{d},\"startColumn\":{d},\"endLine\":{d},\"endColumn\":{d},\"startByte\":{d},\"endByte\":{d}}}", .{
            probe.range.start_line, probe.range.start_column, probe.range.end_line,
            probe.range.end_column, probe.range.start_byte,   probe.range.end_byte,
        });
        if (probe.insertion_byte) |insertion| try writer.print(",\"insertionByte\":{d}", .{insertion});
        try writer.print(",\"mode\":\"{s}\"}}", .{@tagName(probe.mode)});
    }
    try writer.writeAll("],\"parseDiagnostics\":[");
    for (result.parse_diagnostics, 0..) |diagnostic, index| {
        if (index != 0) try writer.writeByte(',');
        try writer.writeAll("{\"message\":");
        try jsonString(writer, diagnostic);
        try writer.writeAll(",\"severity\":\"error\"}");
    }
    try writer.writeAll("]}");
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    var options: Options = .{};
    var index: usize = 1;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--no-auto-inspect")) {
            options.auto_inspect = false;
        } else if (std.mem.eql(u8, arg, "--input") and index + 1 < args.len) {
            index += 1;
            options.input = args[index];
        } else if (std.mem.eql(u8, arg, "--output") and index + 1 < args.len) {
            index += 1;
            options.output = args[index];
        } else if (std.mem.eql(u8, arg, "--source-map") and index + 1 < args.len) {
            index += 1;
            options.source_map = args[index];
        } else if (std.mem.eql(u8, arg, "--uri") and index + 1 < args.len) {
            index += 1;
            options.uri = args[index];
        } else if (std.mem.eql(u8, arg, "--version") and index + 1 < args.len) {
            index += 1;
            options.version = try std.fmt.parseInt(u64, args[index], 10);
        } else if (std.mem.eql(u8, arg, "--manual") and index + 1 < args.len) {
            index += 1;
            try options.manual_ids.append(allocator, args[index]);
        } else {
            std.debug.print("runzig-instrument: invalid argument: {s}\n", .{arg});
            return error.InvalidArguments;
        }
    }
    const input = options.input orelse return error.MissingInput;
    _ = options.output orelse return error.MissingOutput;
    _ = options.source_map orelse return error.MissingSourceMap;

    const bytes = try std.Io.Dir.cwd().readFileAlloc(init.io, input, allocator, .limited(1024 * 1024));
    const source = try allocator.dupeZ(u8, bytes);
    const result = try AstAdapter.instrument(allocator, source, options.uri, options.auto_inspect, options.manual_ids.items);

    var json_writer: std.Io.Writer.Allocating = .init(allocator);
    defer json_writer.deinit();
    try renderResult(&json_writer.writer, result, options);
    const json = json_writer.writer.buffered();

    if (result.generated) |generated| {
        try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = options.output.?, .data = generated });
        try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = options.source_map.?, .data = json });
    }

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_file_writer: std.Io.File.Writer = .init(.stdout(), init.io, &stdout_buffer);
    try stdout_file_writer.interface.writeAll(json);
    try stdout_file_writer.interface.writeByte('\n');
    try stdout_file_writer.interface.flush();
}
