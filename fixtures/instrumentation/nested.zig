fn helper() void {
    const reached = true;
    _ = reached;
}

pub fn main() void {
    if (true) {
        const nested: i32 = 7;
        _ = nested;
    }
    helper();
}
