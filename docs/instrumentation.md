# Instrumentation

`runzig-instrument` parses a sentinel-terminated copy with `std.zig.Ast.parse`. `AstAdapter.zig` is the compatibility boundary for Zig 0.16 AST details.

Eligible local `const`/`var` declarations receive a same-line call immediately after their semicolon. Direct `std.debug.print` and `std.log` statements are followed by a private source marker in the generated copy; compact loop bodies such as `for (...) |i| std.debug.print(...)` are wrapped in a generated block so the marker remains inside every iteration. Node strips that marker and attaches the original line, column, and per-call execution number to the matching terminal output. For logs enclosed by `for` or `while`, the AST adapter also records the innermost loop line and a detected payload, continuation, or condition variable; its runtime value is rendered with the same bounded preview rules. Insertions are sorted by descending original byte offset. Each generated Zig file keeps every original byte in order and exactly the same newline count; visible files under `src/` are never changed by probes and are what Monaco/ZLS use. Non-Zig assets are copied unchanged into the generated mirror for relative `@embedFile` imports.

Probe IDs are SHA-256-derived from algorithm version, URI, original byte range and identifier. The catalog reports both supported and safely omitted declarations. Top-level, comptime, discard identifiers, no-init declarations and type/function/namespace initializers are omitted.

Zig 0.16 reports a later `_ = value;` as pointless once the active probe is a real use. When such a discard is the final statement on its source line, the generated copy prefixes that exact AST assignment with `//`; no newline or original byte is removed. Unsupported same-line cases are left untouched and may produce the ordinary compiler diagnostic.

The runtime reflects the value without replacing it. Scalars and aggregates use bounded formatting; slices cap elements, strings are escaped, non-slice pointers show only addresses, and unavailable categories produce an explicit placeholder. Event writes are mutex-protected and write failures on fd 3 are ignored.

ZLS unused diagnostics are filtered only for an active supported probe, an exact probe range, and either a known diagnostic code or an explicit known message. All other diagnostics remain.
