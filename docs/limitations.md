# Current limitations

- This is **not a strong security sandbox**. Native Zig code executes locally with the user's permissions and can access files, processes and the network. Use Auto Run and review untrusted code.
- Linux and macOS are supported; Windows process groups and fd 3 are outside this MVP.
- Multi-file text projects are supported, but there is no external package/dependency manager and binary file editing is not supported.
- No stdin or interactive terminal.
- Value previews are bounded text, not expandable object trees. Arbitrary pointers are never dereferenced.
- The generated-copy workaround for an observed `_ = name;` applies only when the AST assignment is the last statement on its line.
- ZLS is restarted once after failure, but the browser asks for reload to reinitialize the restarted protocol session.
- Process time/output caps are resource controls, not isolation. CPU/memory beyond the execution timeout are not controlled by cgroups or containers.
- Manual probe IDs are session/URI-specific and are not restored across a new temporary session.
- Tests run sequentially in one process after the program run. A panic inside a test aborts the remaining tests (they are reported from the interruption), and failure messages are correlated from stderr heuristically, so a message can occasionally attach to the neighbouring test.
- Test discovery is regex-based over `test "…"`/`test decl {` lines; exotic formatting (a `test` keyword mid-line) is executed by the runner but may miss catalog mapping.
- Rust: per-test durations are wall-clock arrival deltas (libtest exposes no stable timing) and failure messages come from the captured `---- name stdout ----` blocks; probes cover simple `let` bindings only (no destructuring), and rust-analyzer needs a few seconds of indexing after a session starts before completions appear.
- Go: all `.go` files live in one `package main` under `src/` (subfolder packages are not wired into the module yet); tests follow the `*_test.go` convention; `gopls` needs Go on PATH and indexes on first start.
- Folders are implicit (they exist through their files); renaming or deleting a whole folder means moving its files one by one.
- TS/JS: Node's type stripping runs erasable TypeScript only (no `enum`/`namespace` values); relative imports need explicit `.ts` extensions; `tsc` type errors are diagnostics and never stop the run.
- Python: probes cover simple `name = …` / `name: T = …` assignments (reassignments re-emit with an execution count); test files import the visible modules, so the program's top level runs again during the test phase.
- C/C++: previews cover arithmetic types and `char*` in C (`_Generic`) and anything with `operator<<` in C++; the instrumenter parses with empty stub headers, so declarations of template-heavy unknown types can be missed (they run fine, just without a probe); a failing `assert()` aborts the test binary, so later tests stay unreported for that run.
- Node 22 is the deployment baseline; Node 23/24 are accepted for development to support current host environments.

## Low-level peek panel

- Bit flips in the peek grid are local what-ifs: they re-render the panel's
  derived values but never patch or re-run the program (reset restores).
- Struct field tables (offset/size per field) come from the Zig runtime only;
  Rust/Go/C/C++ report overall size/align (plus bit width for integers).
- The `A · op · B` rows appear only when the line is a bit operation with a
  literal operand and a previous value of the same variable is known.
- Heap timelines, leak/peak accounting per allocation and freed-pointer
  tracking from the design mock require allocator hooks and are not built.
- Addresses (`dirección`) are not reported: probes observe copies, so the
  copy's address would be misleading rather than informative.
