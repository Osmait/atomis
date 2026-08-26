const std = @import("std");

pub fn main() void {
    const price: i32 = 40;
    const tax: i32 = 3;
    const total = price + tax;
    const values = [_]i32{ price, tax, total };

    _ = values;
}
