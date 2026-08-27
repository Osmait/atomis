# Instrumentation

`runzig-instrument` parses a sentinel-terminated copy with `std.zig.Ast.parse`. `AstAdapter.zig` is the compatibility boundary for Zig 0.16 AST details.

Eligible local `const`/`var` declarations receive a same-line call immediately after their semicolon. Direct `std.debug.print` and `std.log` statements are followed by a private source marker in the generated copy; compact loop bodies such as `for (...) |i| std.debug.print(...)` are wrapped in a generated block so the marker remains inside every iteration. Node strips that marker and attaches the original line, column, and per-call execution number to the matching terminal output. For logs enclosed by `for` or `while`, the AST adapter also records the innermost loop line and a detected payload, continuation, or condition variable; its runtime value is rendered with the same bounded preview rules. Insertions are sorted by descending original byte offset. Each generated Zig file keeps every original byte in order and exactly the same newline count; visible files under `src/` are never changed by probes and are what Monaco/ZLS use. Non-Zig assets are copied unchanged into the generated mirror for relative `@embedFile` imports.

Probe IDs are SHA-256-derived from algorithm version, URI, original byte range and identifier. The catalog reports both supported and safely omitted declarations. Top-level, comptime, discard identifiers, no-init declarations and type/function/namespace initializers are omitted.

Zig 0.16 reports a later `_ = value;` as pointless once the active probe is a real use. When such a discard is the final statement on its source line, the generated copy prefixes that exact AST assignment with `//`; no newline or original byte is removed. Unsupported same-line cases are left untouched and may produce the ordinary compiler diagnostic.

The runtime reflects the value without replacing it. Scalars and aggregates use bounded formatting; slices cap elements, strings are escaped, non-slice pointers show only addresses, and unavailable categories produce an explicit placeholder. Event writes are mutex-protected and write failures on fd 3 are ignored.

ZLS unused diagnostics are filtered only for an active supported probe, an exact probe range, and either a known diagnostic code or an explicit known message. All other diagnostics remain.

## Tests

The test binary compiles the **visible** sources under `src/`, never the instrumented mirror, so probes cannot alter test semantics and the probe channel stays free for the runner. A generated `test_root.zig` imports every project `.zig` file; `runzig_test_runner.zig` runs each collected test sequentially, resets `std.testing.allocator_instance` around it to detect leaks, times it with the monotonic clock, and reports `test_start`/`test_result`/`test_summary` NDJSON on fd 3. Failure details rely on the stderr the test wrote between its start and result records, falling back to the Zig error name.

## Rust

`rustlive-instrument` (`rust/instrumenter/`, `syn` + `proc-macro2` vendored for offline builds) mirrors the Zig contract. Simple `let ident = …;` bindings in function bodies get a same-line `crate::atomis_probe!(id, line, column, "name", &name);` call after the semicolon; destructuring patterns and `let` without initializer are reported as unsupported, and locals inside `#[test]` items are omitted. Direct `println!`/`print!`/`eprintln!`/`eprint!`/`dbg!` statements get a marker call on their own stream, with the innermost `for`/`while` loop line and variable when available. Probe previews use autoref specialization: `Debug` types render `{:?}`, everything else reports `<sin Debug: Type>` with `std::any::type_name`. The runtime module is appended at the end of the generated entry file, so every existing line keeps its number, and NDJSON probe records flow over the same fd 3 protocol. Probe IDs are FNV-1a-derived from URI, byte range and identifier.

## Low-level assignment re-probes (Zig)

Besides `const`/`var` declarations, the Zig instrumenter re-probes assignments
to plain identifiers (`x = …` and every compound form: `<<=`, `&=`, `+%=` …)
when the assignment is a direct block statement outside comptime. The probe is
appended after the statement's semicolon, so it reports the value *after* the
mutation without changing line counts. This is what powers the peek panel's
`A · op · B = result` rows: the previous value comes from the same probe's
history (loops) or from the closest earlier probe of the same variable by
runtime sequence, and the operator/operand are parsed lexically from the line
(literal operands only). Other languages currently probe declarations only.
