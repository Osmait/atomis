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
- Node 22 is the deployment baseline; Node 23/24 are accepted for development to support current host environments.
