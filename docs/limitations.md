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
- Node 22 is the deployment baseline; Node 23/24 are accepted for development to support current host environments.
