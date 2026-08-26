const std = @import("std");
const Ast = std.zig.Ast;

pub const Range = struct {
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    start_byte: usize,
    end_byte: usize,
};

pub const Probe = struct {
    probe_id: [32]u8,
    name: []const u8,
    supported: bool,
    reason: ?[]const u8,
    range: Range,
    insertion_byte: ?usize,
    mode: enum { auto, manual },
};

pub const Result = struct {
    generated: ?[]u8,
    probes: []Probe,
    parse_diagnostics: [][]const u8,
};

fn position(source: []const u8, byte_offset: usize) struct { line: usize, column: usize } {
    var line: usize = 1;
    var column: usize = 1;
    var index: usize = 0;
    while (index < @min(byte_offset, source.len)) {
        if (source[index] == '\n') {
            line += 1;
            column = 1;
            index += 1;
            continue;
        }
        const width = std.unicode.utf8ByteSequenceLength(source[index]) catch 1;
        index += @min(width, source.len - index);
        column += 1;
    }
    return .{ .line = line, .column = column };
}

fn isRoot(tree: Ast, node: Ast.Node.Index) bool {
    for (tree.rootDecls()) |root| if (root == node) return true;
    return false;
}

fn inComptime(tree: Ast, node: Ast.Node.Index) bool {
    const first = tree.tokenStart(tree.firstToken(node));
    const last_token = tree.lastToken(node);
    const last = tree.tokenStart(last_token) + tree.tokenSlice(last_token).len;
    var index: usize = 1;
    while (index < tree.nodes.len) : (index += 1) {
        const candidate: Ast.Node.Index = @enumFromInt(index);
        if (tree.nodeTag(candidate) != .@"comptime") continue;
        const candidate_first = tree.tokenStart(tree.firstToken(candidate));
        const candidate_last_token = tree.lastToken(candidate);
        const candidate_last = tree.tokenStart(candidate_last_token) + tree.tokenSlice(candidate_last_token).len;
        if (candidate_first <= first and candidate_last >= last) return true;
    }
    return false;
}

fn isLogCallee(name: []const u8) bool {
    if (std.mem.eql(u8, name, "std.debug.print")) return true;
    inline for (.{ "std.log.debug", "std.log.info", "std.log.warn", "std.log.err" }) |candidate| {
        if (std.mem.eql(u8, name, candidate)) return true;
    }
    return false;
}

fn isDirectBlockStatement(tree: Ast, node: Ast.Node.Index) bool {
    var block_buffer: [2]Ast.Node.Index = undefined;
    var index: usize = 1;
    while (index < tree.nodes.len) : (index += 1) {
        const candidate: Ast.Node.Index = @enumFromInt(index);
        const statements = tree.blockStatements(&block_buffer, candidate) orelse continue;
        for (statements) |statement| if (statement == node) return true;
    }
    return false;
}

fn unsupportedInitializer(tree: Ast, init_node: Ast.Node.Index) bool {
    return switch (tree.nodeTag(init_node)) {
        .fn_decl,
        .fn_proto,
        .fn_proto_multi,
        .fn_proto_one,
        .fn_proto_simple,
        .container_decl,
        .container_decl_trailing,
        .container_decl_two,
        .container_decl_two_trailing,
        .container_decl_arg,
        .container_decl_arg_trailing,
        => true,
        else => false,
    };
}

fn probeId(uri: []const u8, start: usize, end: usize, name: []const u8) [32]u8 {
    var hash: [32]u8 = undefined;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update("ziglive-probe-v1\x00");
    hasher.update(uri);
    var numbers: [16]u8 = undefined;
    std.mem.writeInt(u64, numbers[0..8], start, .little);
    std.mem.writeInt(u64, numbers[8..16], end, .little);
    hasher.update(&numbers);
    hasher.update(name);
    hasher.final(&hash);
    var short: [32]u8 = undefined;
    _ = std.fmt.bufPrint(&short, "{x}", .{hash[0..16]}) catch unreachable;
    return short;
}

fn selected(id: *const [32]u8, manual_ids: []const []const u8) bool {
    for (manual_ids) |manual| if (std.mem.eql(u8, id, manual)) return true;
    return false;
}

pub fn instrument(
    allocator: std.mem.Allocator,
    source: [:0]const u8,
    uri: []const u8,
    auto_inspect: bool,
    manual_ids: []const []const u8,
) !Result {
    if (std.mem.indexOf(u8, source, "@import(\"runzig_runtime.zig\").probe(") != null or
        std.mem.indexOf(u8, source, "@import(\"runzig_runtime.zig\").logSource(") != null)
    {
        return .{
            .generated = try allocator.dupe(u8, source[0..source.len]),
            .probes = try allocator.alloc(Probe, 0),
            .parse_diagnostics = try allocator.alloc([]const u8, 0),
        };
    }
    var tree = try Ast.parse(allocator, source, .zig);
    defer tree.deinit(allocator);

    if (tree.errors.len != 0) {
        var diagnostics: std.ArrayList([]const u8) = .empty;
        for (tree.errors) |parse_error| {
            var buffer: [512]u8 = undefined;
            var writer: std.Io.Writer = .fixed(&buffer);
            tree.renderError(parse_error, &writer) catch {};
            try diagnostics.append(allocator, try allocator.dupe(u8, writer.buffered()));
        }
        return .{ .generated = null, .probes = &.{}, .parse_diagnostics = try diagnostics.toOwnedSlice(allocator) };
    }

    var probes: std.ArrayList(Probe) = .empty;
    var node_index: usize = 1;
    while (node_index < tree.nodes.len) : (node_index += 1) {
        const node: Ast.Node.Index = @enumFromInt(node_index);
        const declaration = tree.fullVarDecl(node) orelse continue;
        const name_token = declaration.ast.mut_token + 1;
        const name = tree.tokenSlice(name_token);
        const first_byte = tree.tokenStart(declaration.firstToken());
        var last_token = tree.lastToken(node);
        if (tree.tokenTag(last_token + 1) == .semicolon) last_token += 1;
        const end_byte = tree.tokenStart(last_token) + tree.tokenSlice(last_token).len;
        const start_pos = position(source, first_byte);
        const end_pos = position(source, end_byte);
        var supported = true;
        var reason: ?[]const u8 = null;

        if (isRoot(tree, node) or tree.nodeTag(node) == .global_var_decl) {
            supported = false;
            reason = "top-level declaration";
        } else if (std.mem.eql(u8, name, "_")) {
            supported = false;
            reason = "discard identifier";
        } else if (declaration.comptime_token != null or inComptime(tree, node)) {
            supported = false;
            reason = "comptime context";
        } else if (declaration.ast.init_node.unwrap()) |init_node| {
            if (unsupportedInitializer(tree, init_node)) {
                supported = false;
                reason = "type, namespace, or function value";
            }
        } else {
            supported = false;
            reason = "declaration has no initializer";
        }

        const id = probeId(uri, first_byte, end_byte, name);
        const is_manual = selected(&id, manual_ids);
        const active = supported and (auto_inspect or is_manual);
        try probes.append(allocator, .{
            .probe_id = id,
            .name = try allocator.dupe(u8, name),
            .supported = supported,
            .reason = reason,
            .range = .{
                .start_line = start_pos.line,
                .start_column = start_pos.column,
                .end_line = end_pos.line,
                .end_column = end_pos.column,
                .start_byte = first_byte,
                .end_byte = end_byte,
            },
            .insertion_byte = if (active) end_byte else null,
            .mode = if (is_manual) .manual else .auto,
        });
    }

    const Insertion = struct {
        offset: usize,
        kind: enum { probe, comment_open, log_marker },
        probe_index: usize = 0,
        line: usize = 0,
        column: usize = 0,
    };
    var insertions: std.ArrayList(Insertion) = .empty;
    defer insertions.deinit(allocator);
    for (probes.items, 0..) |probe, index| {
        if (probe.insertion_byte) |offset| try insertions.append(allocator, .{ .offset = offset, .kind = .probe, .probe_index = index });
    }

    // Append a private marker after direct std.debug.print/std.log statements in the
    // generated copy, allowing Node to attach emitted text to the original
    // source position without changing the visible document or call columns.
    node_index = 1;
    while (node_index < tree.nodes.len) : (node_index += 1) {
        const node: Ast.Node.Index = @enumFromInt(node_index);
        var call_buffer: [1]Ast.Node.Index = undefined;
        const call = tree.fullCall(&call_buffer, node) orelse continue;
        const fn_first = tree.tokenStart(tree.firstToken(call.ast.fn_expr));
        const fn_last_token = tree.lastToken(call.ast.fn_expr);
        const fn_last = tree.tokenStart(fn_last_token) + tree.tokenSlice(fn_last_token).len;
        if (!isLogCallee(source[fn_first..fn_last])) continue;
        if (inComptime(tree, node) or !isDirectBlockStatement(tree, node)) continue;
        const call_last_token = tree.lastToken(node);
        const semicolon = call_last_token + 1;
        if (tree.tokenTag(semicolon) != .semicolon) continue;
        const marker_offset = tree.tokenStart(semicolon) + tree.tokenSlice(semicolon).len;
        const call_pos = position(source, fn_first);
        try insertions.append(allocator, .{ .offset = marker_offset, .kind = .log_marker, .line = call_pos.line, .column = call_pos.column });
    }

    // Zig 0.16 diagnoses `_ = value;` as a pointless discard once a probe also
    // observes value. Comment only those exact AST assignments in the generated
    // copy; all original bytes remain present and line counts stay unchanged.
    node_index = 1;
    while (node_index < tree.nodes.len) : (node_index += 1) {
        const node: Ast.Node.Index = @enumFromInt(node_index);
        if (tree.nodeTag(node) != .assign) continue;
        const lhs, const rhs = tree.nodeData(node).node_and_node;
        if (tree.nodeTag(lhs) != .identifier or tree.nodeTag(rhs) != .identifier) continue;
        if (!std.mem.eql(u8, tree.tokenSlice(tree.nodeMainToken(lhs)), "_")) continue;
        const rhs_name = tree.tokenSlice(tree.nodeMainToken(rhs));
        var observed = false;
        for (probes.items) |probe| {
            if (probe.insertion_byte != null and std.mem.eql(u8, probe.name, rhs_name)) observed = true;
        }
        if (!observed) continue;
        const first = tree.tokenStart(tree.firstToken(node));
        var last_token = tree.lastToken(node);
        if (tree.tokenTag(last_token + 1) == .semicolon) last_token += 1;
        const last = tree.tokenStart(last_token) + tree.tokenSlice(last_token).len;
        const line_end = std.mem.indexOfScalarPos(u8, source, last, '\n') orelse source.len;
        if (std.mem.trim(u8, source[last..line_end], " \t\r").len != 0) continue;
        try insertions.append(allocator, .{ .offset = first, .kind = .comment_open });
    }
    std.mem.sort(Insertion, insertions.items, {}, struct {
        fn lessThan(_: void, left: Insertion, right: Insertion) bool {
            return left.offset > right.offset;
        }
    }.lessThan);

    var generated: std.ArrayList(u8) = .empty;
    try generated.appendSlice(allocator, source[0..source.len]);
    for (insertions.items) |insertion| switch (insertion.kind) {
        .comment_open => try generated.insertSlice(allocator, insertion.offset, "// ziglive: observed discard "),
        .log_marker => {
            var snippet: [192]u8 = undefined;
            const text = try std.fmt.bufPrint(&snippet, " @import(\"runzig_runtime.zig\").logSource(.{{ .line = {d}, .column = {d} }});", .{ insertion.line, insertion.column });
            try generated.insertSlice(allocator, insertion.offset, text);
        },
        .probe => {
            const probe = probes.items[insertion.probe_index];
            var snippet: [512]u8 = undefined;
            const text = try std.fmt.bufPrint(&snippet, " @import(\"runzig_runtime.zig\").probe(\"{s}\", {s}, .{{ .line = {d}, .column = {d}, .name = \"{s}\" }});", .{ &probe.probe_id, probe.name, probe.range.start_line, probe.range.start_column, probe.name });
            try generated.insertSlice(allocator, insertion.offset, text);
        },
    };

    std.mem.sort(Probe, probes.items, {}, struct {
        fn lessThan(_: void, left: Probe, right: Probe) bool {
            return left.range.start_byte < right.range.start_byte;
        }
    }.lessThan);

    return .{
        .generated = try generated.toOwnedSlice(allocator),
        .probes = try probes.toOwnedSlice(allocator),
        .parse_diagnostics = &.{},
    };
}

test "instruments local declarations and preserves lines" {
    const source: [:0]const u8 = "const top = 1;\npub fn main() void {\n const x: i32 = 2; const y = x + 1;\n _ = y;\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///main.zig", true, &.{});
    defer {
        if (result.generated) |generated| std.testing.allocator.free(generated);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expectEqual(@as(usize, 3), result.probes.len);
    try std.testing.expect(!result.probes[0].supported);
    try std.testing.expectEqual(std.mem.count(u8, source, "\n"), std.mem.count(u8, result.generated.?, "\n"));
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "probe(") != null);
}

test "marks log statements with original source locations" {
    const source: [:0]const u8 = "const std = @import(\"std\");\npub fn main() void {\n    std.debug.print(\"hello\\n\", .{});\n    std.log.info(\"world\", .{});\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///logs.zig", false, &.{});
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "std.debug.print(\"hello\\n\", .{}); @import(\"runzig_runtime.zig\").logSource(.{ .line = 3, .column = 5 });") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "std.log.info(\"world\", .{}); @import(\"runzig_runtime.zig\").logSource(.{ .line = 4, .column = 5 });") != null);
    try std.testing.expectEqual(std.mem.count(u8, source, "\n"), std.mem.count(u8, result.generated.?, "\n"));
}

test "parse errors do not generate source" {
    const source: [:0]const u8 = "pub fn main( {";
    const result = try instrument(std.testing.allocator, source, "file:///bad.zig", true, &.{});
    defer {
        for (result.parse_diagnostics) |diagnostic| std.testing.allocator.free(diagnostic);
        std.testing.allocator.free(result.parse_diagnostics);
    }
    try std.testing.expect(result.generated == null);
    try std.testing.expect(result.parse_diagnostics.len > 0);
}

test "ids deterministic and Unicode position is codepoint based" {
    const source: [:0]const u8 = "pub fn main() void { const smile = \"😀\"; const x = 1; _ = .{ smile, x }; }";
    const first = try instrument(std.testing.allocator, source, "file:///unicode.zig", false, &.{});
    const second = try instrument(std.testing.allocator, source, "file:///unicode.zig", false, &.{});
    defer {
        for (first.probes) |probe| std.testing.allocator.free(probe.name);
        for (second.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(first.probes);
        std.testing.allocator.free(second.probes);
        std.testing.allocator.free(first.generated.?);
        std.testing.allocator.free(second.generated.?);
    }
    try std.testing.expectEqualStrings(&first.probes[1].probe_id, &second.probes[1].probe_id);
    try std.testing.expect(first.probes[1].range.start_byte > first.probes[1].range.start_column);
}

test "nested blocks branches loops and other functions are discovered" {
    const source: [:0]const u8 =
        "fn helper() void { const h = 1; _ = h; }\n" ++
        "pub fn main() void {\n" ++
        " if (true) { var branch: i32 = 2; branch += 1; }\n" ++
        " while (false) { const loop_value = 3; _ = loop_value; }\n" ++
        " { const nested = 4; _ = nested; }\n" ++
        " helper();\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///nested.zig", true, &.{});
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    var supported: usize = 0;
    for (result.probes) |probe| supported += @intFromBool(probe.supported);
    try std.testing.expectEqual(@as(usize, 4), supported);
    try std.testing.expectEqual(std.mem.count(u8, source, "\n"), std.mem.count(u8, result.generated.?, "\n"));
}

test "top-level comptime and type-producing declarations are safely omitted" {
    const source: [:0]const u8 =
        "const global = 1;\n" ++
        "pub fn main() void {\n" ++
        " comptime { const compile_value = 2; _ = compile_value; }\n" ++
        " const Namespace = struct { value: i32 };\n" ++
        " _ = Namespace;\n" ++
        "}\n";
    const result = try instrument(std.testing.allocator, source, "file:///omitted.zig", true, &.{});
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    for (result.probes) |probe| try std.testing.expect(!probe.supported);
}

test "comments and strings do not create declarations and manual mode selects one id" {
    const source: [:0]const u8 =
        "pub fn main() void {\n" ++
        " // const fake = 1;\n" ++
        " const text = \"var fake = 2;\";\n" ++
        " _ = text;\n" ++
        "}\n";
    const catalog = try instrument(std.testing.allocator, source, "file:///manual.zig", false, &.{});
    defer {
        std.testing.allocator.free(catalog.generated.?);
        for (catalog.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(catalog.probes);
    }
    try std.testing.expectEqual(@as(usize, 1), catalog.probes.len);
    try std.testing.expect(catalog.probes[0].insertion_byte == null);
    const manual_ids = [_][]const u8{&catalog.probes[0].probe_id};
    const manual = try instrument(std.testing.allocator, source, "file:///manual.zig", false, &manual_ids);
    defer {
        std.testing.allocator.free(manual.generated.?);
        for (manual.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(manual.probes);
    }
    try std.testing.expect(manual.probes[0].insertion_byte != null);
    try std.testing.expectEqual(.manual, manual.probes[0].mode);
}

test "destructuring declarations are catalogued as unsupported" {
    const source: [:0]const u8 = "pub fn main() void { const a, const b = .{ 1, 2 }; _ = .{ a, b }; }";
    const result = try instrument(std.testing.allocator, source, "file:///destructure.zig", true, &.{});
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expectEqual(@as(usize, 2), result.probes.len);
    for (result.probes) |probe| {
        try std.testing.expect(!probe.supported);
        try std.testing.expectEqualStrings("declaration has no initializer", probe.reason.?);
    }
}

test "generated code is not reinstrumented" {
    const source: [:0]const u8 = "pub fn main() void { const x = 1; }";
    const first = try instrument(std.testing.allocator, source, "file:///once.zig", true, &.{});
    defer {
        for (first.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(first.probes);
        std.testing.allocator.free(first.generated.?);
    }
    const sentinel = try std.testing.allocator.dupeZ(u8, first.generated.?);
    defer std.testing.allocator.free(sentinel);
    const second = try instrument(std.testing.allocator, sentinel, "file:///once.zig", true, &.{});
    defer {
        std.testing.allocator.free(second.probes);
        std.testing.allocator.free(second.parse_diagnostics);
        std.testing.allocator.free(second.generated.?);
    }
    try std.testing.expectEqualStrings(first.generated.?, second.generated.?);
    try std.testing.expectEqual(@as(usize, 0), second.probes.len);
}
