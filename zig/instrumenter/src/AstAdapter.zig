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

pub const ParseDiagnostic = struct {
    message: []const u8,
    line: usize,
    column: usize,
};

pub const Result = struct {
    generated: ?[]u8,
    probes: []Probe,
    parse_diagnostics: []ParseDiagnostic,
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

fn isDirectLoopBody(tree: Ast, node: Ast.Node.Index) bool {
    var index: usize = 1;
    while (index < tree.nodes.len) : (index += 1) {
        const candidate: Ast.Node.Index = @enumFromInt(index);
        if (tree.fullFor(candidate)) |loop| {
            if (loop.ast.then_expr == node) return true;
        } else if (tree.fullWhile(candidate)) |loop| {
            if (loop.ast.then_expr == node) return true;
        }
    }
    return false;
}

const ByteSpan = struct { first: usize, last: usize };

/// The byte span of the innermost function body containing `node`, so a
/// question about scope ("does a probe observe this variable HERE?") never
/// reaches across functions that merely reuse a name.
fn enclosingFunctionSpan(tree: Ast, node: Ast.Node.Index) ?ByteSpan {
    const node_first = tree.tokenStart(tree.firstToken(node));
    const node_last_token = tree.lastToken(node);
    const node_last = tree.tokenStart(node_last_token) + tree.tokenSlice(node_last_token).len;
    var best: ?ByteSpan = null;
    var best_span: usize = std.math.maxInt(usize);
    var index: usize = 1;
    while (index < tree.nodes.len) : (index += 1) {
        const candidate: Ast.Node.Index = @enumFromInt(index);
        if (tree.nodeTag(candidate) != .fn_decl) continue;
        const first = tree.tokenStart(tree.firstToken(candidate));
        const last_token = tree.lastToken(candidate);
        const last = tree.tokenStart(last_token) + tree.tokenSlice(last_token).len;
        if (node_first < first or node_last > last or last - first >= best_span) continue;
        best = .{ .first = first, .last = last };
        best_span = last - first;
    }
    return best;
}

const LoopContext = struct {
    line: usize,
    column: usize,
    variable: []const u8,
};

fn plainIdentifier(value: []const u8) bool {
    if (value.len == 0 or !(std.ascii.isAlphabetic(value[0]) or value[0] == '_')) return false;
    for (value[1..]) |byte| if (!(std.ascii.isAlphanumeric(byte) or byte == '_')) return false;
    return !std.mem.eql(u8, value, "_");
}

fn lastPayloadIdentifier(tree: Ast, first_token: Ast.TokenIndex) ?Ast.TokenIndex {
    var result: ?Ast.TokenIndex = null;
    var token = first_token;
    while (token < tree.tokens.len and tree.tokenTag(token) != .pipe) : (token += 1) {
        if (tree.tokenTag(token) == .identifier and plainIdentifier(tree.tokenSlice(token))) result = token;
    }
    return result;
}

fn firstNodeIdentifier(tree: Ast, node: Ast.Node.Index) ?Ast.TokenIndex {
    var token = tree.firstToken(node);
    const last = tree.lastToken(node);
    while (token <= last) : (token += 1) {
        if (tree.tokenTag(token) == .identifier and plainIdentifier(tree.tokenSlice(token))) return token;
    }
    return null;
}

fn enclosingLoop(tree: Ast, source: []const u8, node: Ast.Node.Index) ?LoopContext {
    const node_first = tree.tokenStart(tree.firstToken(node));
    const node_last_token = tree.lastToken(node);
    const node_last = tree.tokenStart(node_last_token) + tree.tokenSlice(node_last_token).len;
    var best: ?LoopContext = null;
    var best_span: usize = std.math.maxInt(usize);
    var index: usize = 1;
    while (index < tree.nodes.len) : (index += 1) {
        const candidate: Ast.Node.Index = @enumFromInt(index);
        var loop_token: Ast.TokenIndex = undefined;
        var body: Ast.Node.Index = undefined;
        var variable_token: ?Ast.TokenIndex = null;
        if (tree.fullFor(candidate)) |loop| {
            loop_token = loop.ast.for_token;
            body = loop.ast.then_expr;
            variable_token = lastPayloadIdentifier(tree, loop.payload_token);
        } else if (tree.fullWhile(candidate)) |loop| {
            loop_token = loop.ast.while_token;
            body = loop.ast.then_expr;
            variable_token = if (loop.payload_token) |payload|
                lastPayloadIdentifier(tree, payload)
            else if (loop.ast.cont_expr.unwrap()) |continuation|
                firstNodeIdentifier(tree, continuation)
            else
                firstNodeIdentifier(tree, loop.ast.cond_expr);
        } else continue;
        const body_first = tree.tokenStart(tree.firstToken(body));
        const body_last_token = tree.lastToken(body);
        const body_last = tree.tokenStart(body_last_token) + tree.tokenSlice(body_last_token).len;
        if (node_first < body_first or node_last > body_last or body_last - body_first >= best_span) continue;
        const token = variable_token orelse continue;
        const loop_pos = position(source, tree.tokenStart(loop_token));
        best = .{ .line = loop_pos.line, .column = loop_pos.column, .variable = tree.tokenSlice(token) };
        best_span = body_last - body_first;
    }
    return best;
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
    hasher.update("atomis-probe-v1\x00");
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
    file_id: u32,
) !Result {
    if (std.mem.indexOf(u8, source, "@import(\"runzig_runtime.zig\").probe(") != null or
        std.mem.indexOf(u8, source, "@import(\"runzig_runtime.zig\").logSource(") != null or
        std.mem.indexOf(u8, source, "@import(\"runzig_runtime.zig\").logSourceLoop(") != null)
    {
        return .{
            .generated = try allocator.dupe(u8, source[0..source.len]),
            .probes = try allocator.alloc(Probe, 0),
            .parse_diagnostics = try allocator.alloc(ParseDiagnostic, 0),
        };
    }
    var tree = try Ast.parse(allocator, source, .zig);
    defer tree.deinit(allocator);

    if (tree.errors.len != 0) {
        var diagnostics: std.ArrayList(ParseDiagnostic) = .empty;
        for (tree.errors) |parse_error| {
            var buffer: [512]u8 = undefined;
            var writer: std.Io.Writer = .fixed(&buffer);
            tree.renderError(parse_error, &writer) catch {};
            var byte_offset = tree.tokenStart(parse_error.token);
            if (parse_error.token_is_prev) byte_offset += @intCast(tree.tokenSlice(parse_error.token).len);
            const location = position(source, byte_offset);
            try diagnostics.append(allocator, .{
                .message = try allocator.dupe(u8, writer.buffered()),
                .line = location.line,
                .column = location.column,
            });
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
            } else if (tree.firstToken(init_node) == tree.lastToken(init_node) and
                std.mem.eql(u8, tree.tokenSlice(tree.firstToken(init_node)), "undefined"))
            {
                // Rendering `undefined` reads it: a 4MB undefined buffer is
                // a stack-sized copy, and an undefined enum's tag panics in
                // Debug — inside a program that never asked to.
                supported = false;
                reason = "undefined value";
            }
        } else {
            supported = false;
            reason = "declaration has no initializer";
        }
        if (supported and !isDirectBlockStatement(tree, node)) {
            // A struct/enum/union member `const` is a declaration, not a
            // statement: splicing a call after it does not parse
            // ("declarations are not allowed between container fields").
            // Same standard the assignment loop below already applies.
            supported = false;
            reason = "container-level declaration";
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

    // Assignments to plain identifiers (`x = …`, `x <<= …`) re-probe the
    // variable so bit operations expose their intermediate values; the peek
    // panel derives its A · op · B rows from this history. Statement position
    // only (mirrors log markers) so the appended probe stays in the block.
    node_index = 1;
    while (node_index < tree.nodes.len) : (node_index += 1) {
        const node: Ast.Node.Index = @enumFromInt(node_index);
        switch (tree.nodeTag(node)) {
            .assign, .assign_mul, .assign_div, .assign_mod, .assign_add, .assign_sub, .assign_shl, .assign_shl_sat, .assign_shr, .assign_bit_and, .assign_bit_xor, .assign_bit_or, .assign_mul_wrap, .assign_add_wrap, .assign_sub_wrap, .assign_mul_sat, .assign_add_sat, .assign_sub_sat => {},
            else => continue,
        }
        const lhs, _ = tree.nodeData(node).node_and_node;
        if (tree.nodeTag(lhs) != .identifier) continue;
        const name = tree.tokenSlice(tree.nodeMainToken(lhs));
        if (std.mem.eql(u8, name, "_")) continue;
        if (inComptime(tree, node) or !isDirectBlockStatement(tree, node)) continue;
        const first_byte = tree.tokenStart(tree.firstToken(node));
        var last_token = tree.lastToken(node);
        if (tree.tokenTag(last_token + 1) != .semicolon) continue;
        last_token += 1;
        const end_byte = tree.tokenStart(last_token) + tree.tokenSlice(last_token).len;
        const start_pos = position(source, first_byte);
        const end_pos = position(source, end_byte);
        const id = probeId(uri, first_byte, end_byte, name);
        const is_manual = selected(&id, manual_ids);
        try probes.append(allocator, .{
            .probe_id = id,
            .name = try allocator.dupe(u8, name),
            .supported = true,
            .reason = null,
            .range = .{
                .start_line = start_pos.line,
                .start_column = start_pos.column,
                .end_line = end_pos.line,
                .end_column = end_pos.column,
                .start_byte = first_byte,
                .end_byte = end_byte,
            },
            .insertion_byte = if (auto_inspect or is_manual) end_byte else null,
            .mode = if (is_manual) .manual else .auto,
        });
    }

    const Insertion = struct {
        offset: usize,
        kind: enum { probe, comment_open, log_block_open, log_marker },
        probe_index: usize = 0,
        line: usize = 0,
        column: usize = 0,
        loop: ?LoopContext = null,
        closes_loop_block: bool = false,
    };
    var insertions: std.ArrayList(Insertion) = .empty;
    defer insertions.deinit(allocator);
    for (probes.items, 0..) |probe, index| {
        if (probe.insertion_byte) |offset| try insertions.append(allocator, .{ .offset = offset, .kind = .probe, .probe_index = index });
    }

    // Append a private marker after direct std.debug.print/std.log statements in the
    // generated copy. Compact loop bodies are wrapped in a generated block so the
    // marker remains inside the loop; the visible document is never changed.
    node_index = 1;
    while (node_index < tree.nodes.len) : (node_index += 1) {
        const node: Ast.Node.Index = @enumFromInt(node_index);
        var call_buffer: [1]Ast.Node.Index = undefined;
        const call = tree.fullCall(&call_buffer, node) orelse continue;
        const fn_first = tree.tokenStart(tree.firstToken(call.ast.fn_expr));
        const fn_last_token = tree.lastToken(call.ast.fn_expr);
        const fn_last = tree.tokenStart(fn_last_token) + tree.tokenSlice(fn_last_token).len;
        if (!isLogCallee(source[fn_first..fn_last])) continue;
        const wraps_loop_body = isDirectLoopBody(tree, node);
        if (inComptime(tree, node) or (!isDirectBlockStatement(tree, node) and !wraps_loop_body)) continue;
        const call_last_token = tree.lastToken(node);
        const semicolon = call_last_token + 1;
        if (tree.tokenTag(semicolon) != .semicolon) continue;
        const marker_offset = tree.tokenStart(semicolon) + tree.tokenSlice(semicolon).len;
        const call_pos = position(source, fn_first);
        if (wraps_loop_body) try insertions.append(allocator, .{
            .offset = tree.tokenStart(tree.firstToken(node)),
            .kind = .log_block_open,
        });
        try insertions.append(allocator, .{
            .offset = marker_offset,
            .kind = .log_marker,
            .line = call_pos.line,
            .column = call_pos.column,
            .loop = enclosingLoop(tree, source, node),
            .closes_loop_block = wraps_loop_body,
        });
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
        // Same name is not same variable: a probe on `y` in one function
        // must not comment out `_ = y;` discarding another function's
        // parameter — that trades one diagnostic for a build error.
        const scope = enclosingFunctionSpan(tree, node);
        var observed = false;
        for (probes.items) |probe| {
            if (probe.insertion_byte == null or !std.mem.eql(u8, probe.name, rhs_name)) continue;
            if (scope) |span| {
                if (probe.range.start_byte < span.first or probe.range.start_byte > span.last) continue;
            }
            observed = true;
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
        .comment_open => try generated.insertSlice(allocator, insertion.offset, "// atomis: observed discard "),
        .log_block_open => try generated.insertSlice(allocator, insertion.offset, "{ "),
        .log_marker => {
            var snippet: [384]u8 = undefined;
            const suffix: []const u8 = if (insertion.closes_loop_block) " }" else "";
            const text = if (insertion.loop) |loop|
                try std.fmt.bufPrint(&snippet, " @import(\"runzig_runtime.zig\").logSourceLoop(.{{ .file_id = {d}, .line = {d}, .column = {d}, .loop_line = {d}, .loop_column = {d}, .loop_name = \"{s}\" }}, {s});{s}", .{ file_id, insertion.line, insertion.column, loop.line, loop.column, loop.variable, loop.variable, suffix })
            else
                try std.fmt.bufPrint(&snippet, " @import(\"runzig_runtime.zig\").logSource(.{{ .file_id = {d}, .line = {d}, .column = {d} }});{s}", .{ file_id, insertion.line, insertion.column, suffix });
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
    const result = try instrument(std.testing.allocator, source, "file:///main.zig", true, &.{}, 0);
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

test "assignments to identifiers are re-probed after the statement" {
    const source =
        "pub fn main() void {\n" ++
        "    var flags: u8 = 43;\n" ++
        "    flags = flags << 1;\n" ++
        "    flags &= 240;\n" ++
        "}\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try instrument(arena.allocator(), source, "file:///t.zig", true, &.{}, 1);
    const generated = result.generated.?;
    try std.testing.expectEqual(@as(usize, 3), result.probes.len);
    try std.testing.expectEqualStrings("flags", result.probes[1].name);
    try std.testing.expectEqual(@as(usize, 3), result.probes[1].range.start_line);
    try std.testing.expectEqual(@as(usize, 4), result.probes[2].range.start_line);
    const line_count = std.mem.count(u8, generated, "\n");
    try std.testing.expectEqual(@as(usize, 5), line_count);
    try std.testing.expect(std.mem.indexOf(u8, generated, "flags = flags << 1; @import(\"runzig_runtime.zig\").probe(") != null);
    try std.testing.expect(std.mem.indexOf(u8, generated, "flags &= 240; @import(\"runzig_runtime.zig\").probe(") != null);
}

test "marks log statements with original source locations" {
    const source: [:0]const u8 = "const std = @import(\"std\");\npub fn main() void {\n    std.debug.print(\"hello\\n\", .{});\n    std.log.info(\"world\", .{});\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///logs.zig", false, &.{}, 0);
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "std.debug.print(\"hello\\n\", .{}); @import(\"runzig_runtime.zig\").logSource(.{ .file_id = 0, .line = 3, .column = 5 });") != null);
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "std.log.info(\"world\", .{}); @import(\"runzig_runtime.zig\").logSource(.{ .file_id = 0, .line = 4, .column = 5 });") != null);
    try std.testing.expectEqual(std.mem.count(u8, source, "\n"), std.mem.count(u8, result.generated.?, "\n"));
}

test "captures the innermost loop variable for logs" {
    const source: [:0]const u8 = "const std = @import(\"std\");\npub fn main() void {\n    for (0..3) |i| {\n        std.debug.print(\"{d}\\n\", .{i});\n    }\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///loop.zig", false, &.{}, 0);
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "logSourceLoop(.{ .file_id = 0, .line = 4, .column = 9, .loop_line = 3, .loop_column = 5, .loop_name = \"i\" }, i)") != null);
}

test "wraps compact loop log bodies without changing visible source positions" {
    const source: [:0]const u8 = "const std = @import(\"std\");\npub fn main() void {\n    for (0..10) |i| std.debug.print(\"{}\\n\", .{i});\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///compact-loop.zig", false, &.{}, 0);
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "|i| { std.debug.print(\"{}\\n\", .{i}); @import(\"runzig_runtime.zig\").logSourceLoop(.{ .file_id = 0, .line = 3, .column = 21, .loop_line = 3, .loop_column = 5, .loop_name = \"i\" }, i); }") != null);
    try std.testing.expectEqual(std.mem.count(u8, source, "\n"), std.mem.count(u8, result.generated.?, "\n"));
}

test "captures a while continuation variable for logs" {
    const source: [:0]const u8 = "const std = @import(\"std\");\npub fn main() void {\n    var i: usize = 0;\n    while (i < 2) : (i += 1) {\n        std.debug.print(\"{d}\\n\", .{i});\n    }\n}\n";
    const result = try instrument(std.testing.allocator, source, "file:///while.zig", false, &.{}, 0);
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    try std.testing.expect(std.mem.indexOf(u8, result.generated.?, "logSourceLoop(.{ .file_id = 0, .line = 5, .column = 9, .loop_line = 4, .loop_column = 5, .loop_name = \"i\" }, i)") != null);
}

test "parse errors do not generate source" {
    const source: [:0]const u8 = "pub fn main( {";
    const result = try instrument(std.testing.allocator, source, "file:///bad.zig", true, &.{}, 0);
    defer {
        for (result.parse_diagnostics) |diagnostic| std.testing.allocator.free(diagnostic.message);
        std.testing.allocator.free(result.parse_diagnostics);
    }
    try std.testing.expect(result.generated == null);
    try std.testing.expect(result.parse_diagnostics.len > 0);
    try std.testing.expect(result.parse_diagnostics[0].line >= 1);
    try std.testing.expect(result.parse_diagnostics[0].column >= 1);
}

test "ids deterministic and Unicode position is codepoint based" {
    const source: [:0]const u8 = "pub fn main() void { const smile = \"😀\"; const x = 1; _ = .{ smile, x }; }";
    const first = try instrument(std.testing.allocator, source, "file:///unicode.zig", false, &.{}, 0);
    const second = try instrument(std.testing.allocator, source, "file:///unicode.zig", false, &.{}, 0);
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
    const result = try instrument(std.testing.allocator, source, "file:///nested.zig", true, &.{}, 0);
    defer {
        std.testing.allocator.free(result.generated.?);
        for (result.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(result.probes);
    }
    var supported: usize = 0;
    for (result.probes) |probe| supported += @intFromBool(probe.supported);
    // Four declarations plus the `branch += 1;` assignment re-probe.
    try std.testing.expectEqual(@as(usize, 5), supported);
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
    const result = try instrument(std.testing.allocator, source, "file:///omitted.zig", true, &.{}, 0);
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
    const catalog = try instrument(std.testing.allocator, source, "file:///manual.zig", false, &.{}, 0);
    defer {
        std.testing.allocator.free(catalog.generated.?);
        for (catalog.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(catalog.probes);
    }
    try std.testing.expectEqual(@as(usize, 1), catalog.probes.len);
    try std.testing.expect(catalog.probes[0].insertion_byte == null);
    const manual_ids = [_][]const u8{&catalog.probes[0].probe_id};
    const manual = try instrument(std.testing.allocator, source, "file:///manual.zig", false, &manual_ids, 0);
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
    const result = try instrument(std.testing.allocator, source, "file:///destructure.zig", true, &.{}, 0);
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

test "a container member const is never probed and the output parses" {
    const source: [:0]const u8 =
        "pub fn main() void {\n" ++
        "    const v = Vec.zero;\n" ++
        "    _ = v;\n" ++
        "}\n" ++
        "const Vec = struct {\n" ++
        "    x: f32,\n" ++
        "    const zero = Vec{ .x = 0 };\n" ++
        "};\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try instrument(arena.allocator(), source, "file:///container.zig", true, &.{}, 0);
    const generated = result.generated.?;
    // Splicing after the member was "declarations are not allowed between
    // container fields": any Zig file with a struct const broke.
    for (result.probes) |probe| {
        if (std.mem.eql(u8, probe.name, "zero")) {
            try std.testing.expect(!probe.supported);
            try std.testing.expectEqualStrings("container-level declaration", probe.reason.?);
        }
    }
    const sentinel = try arena.allocator().dupeZ(u8, generated);
    var tree = try Ast.parse(arena.allocator(), sentinel, .zig);
    try std.testing.expectEqual(@as(usize, 0), tree.errors.len);
    _ = &tree;
}

test "a discard in another function keeps its name" {
    const source: [:0]const u8 =
        "pub fn a() void {\n" ++
        "    const y = 1;\n" ++
        "    _ = y;\n" ++
        "}\n" ++
        "pub fn b(y: i32) void {\n" ++
        "    _ = y;\n" ++
        "}\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try instrument(arena.allocator(), source, "file:///discard.zig", true, &.{}, 0);
    const generated = result.generated.?;
    // a's discard is now pointless (the probe observes y) and is commented;
    // b's discards a PARAMETER a whole function away — commenting it was an
    // "unused function parameter" build error on valid code.
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, generated, "// atomis: observed discard"));
    try std.testing.expect(std.mem.indexOf(u8, generated, "pub fn b(y: i32) void {\n    _ = y;\n}") != null);
}

test "an undefined initializer is catalogued but never rendered" {
    const source: [:0]const u8 =
        "pub fn main() void {\n" ++
        "    var buffer: [64]u8 = undefined;\n" ++
        "    buffer[0] = 1;\n" ++
        "    _ = buffer;\n" ++
        "}\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try instrument(arena.allocator(), source, "file:///undef.zig", true, &.{}, 0);
    for (result.probes) |probe| {
        if (std.mem.eql(u8, probe.name, "buffer") and probe.range.start_line == 2) {
            try std.testing.expect(!probe.supported);
            try std.testing.expectEqualStrings("undefined value", probe.reason.?);
        }
    }
}

test "generated code is not reinstrumented" {
    const source: [:0]const u8 = "pub fn main() void { const x = 1; }";
    const first = try instrument(std.testing.allocator, source, "file:///once.zig", true, &.{}, 0);
    defer {
        for (first.probes) |probe| std.testing.allocator.free(probe.name);
        std.testing.allocator.free(first.probes);
        std.testing.allocator.free(first.generated.?);
    }
    const sentinel = try std.testing.allocator.dupeZ(u8, first.generated.?);
    defer std.testing.allocator.free(sentinel);
    const second = try instrument(std.testing.allocator, sentinel, "file:///once.zig", true, &.{}, 0);
    defer {
        std.testing.allocator.free(second.probes);
        std.testing.allocator.free(second.parse_diagnostics);
        std.testing.allocator.free(second.generated.?);
    }
    try std.testing.expectEqualStrings(first.generated.?, second.generated.?);
    try std.testing.expectEqual(@as(usize, 0), second.probes.len);
}
