// A tiny calculator REPL: it reads what you type, line by line.
// Press Run, then answer under the output: 2 + 3, sum, help, quit.
// Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.
const std = @import("std");

const CalcError = error{ BadInput, NotANumber, DivideByZero };

fn evaluate(line: []const u8) CalcError!f64 {
    var parts = std.mem.tokenizeScalar(u8, line, ' ');
    const a_text = parts.next() orelse return error.BadInput;
    const op = parts.next() orelse return error.BadInput;
    const b_text = parts.next() orelse return error.BadInput;
    if (parts.next() != null or op.len != 1) return error.BadInput;
    const a = std.fmt.parseFloat(f64, a_text) catch return error.NotANumber;
    const b = std.fmt.parseFloat(f64, b_text) catch return error.NotANumber;
    return switch (op[0]) {
        '+' => a + b,
        '-' => a - b,
        '*' => a * b,
        '/' => if (b == 0) error.DivideByZero else a / b,
        else => error.BadInput,
    };
}

fn describe(err: CalcError) []const u8 {
    return switch (err) {
        error.BadInput => "expected: <number> <op> <number>",
        error.NotANumber => "not a number",
        error.DivideByZero => "can't divide by zero",
    };
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    var buffer: [256]u8 = undefined;
    var stdin = std.Io.File.stdin().readerStreaming(init.io, &buffer);
    var results: std.ArrayList(f64) = .empty;

    std.debug.print("Tiny calculator. Try 2 + 3, or: help, sum, quit\n", .{});
    while (true) {
        std.debug.print("> ", .{});
        const raw = (stdin.interface.takeDelimiter('\n') catch break) orelse break;
        const line = std.mem.trim(u8, raw, " \t\r");
        if (std.mem.eql(u8, line, "quit")) break;
        if (line.len == 0) continue;
        if (std.mem.eql(u8, line, "help")) {
            std.debug.print("<number> <op> <number>, with op one of + - * /\n", .{});
        } else if (std.mem.eql(u8, line, "sum")) {
            var total: f64 = 0;
            for (results.items) |result| total += result;
            std.debug.print("total of {d} results: {d}\n", .{ results.items.len, total });
        } else {
            const result = evaluate(line) catch |err| {
                std.debug.print("? {s}\n", .{describe(err)});
                continue;
            };
            try results.append(allocator, result);
            std.debug.print("{d}\n", .{result});
        }
    }
    std.debug.print("bye\n", .{});
}
