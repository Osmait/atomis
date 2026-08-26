const std = @import("std");

pub fn main() void {
    std.debug.panic("fixture panic", .{});
}
