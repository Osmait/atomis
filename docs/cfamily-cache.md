# C/C++ precompiled runtime cache

Atomis stores generated runtime precompiled headers in each workspace's
`target/` directory. Clang records the runtime header's absolute path inside
the PCH. AppImage mount paths change between launches, so a compiler-only
cache key is not sufficient, even when the header contents are unchanged.

The runner reuses a PCH only when it is newer than its header and its stamp
matches both the compiler identity and the canonical runtime header path.
Legacy compiler-only stamps are rejected automatically. Before rebuilding,
the old success stamp is removed so an interrupted compile cannot certify a
partial PCH. If precompilation fails, the runner uses the ordinary header.

Desktop and Tailscale are separate installations. Updating the web service
does not update an installed AppImage. Build and install both when a server
or instrumenter fix must reach both entry points. Older desktop builds can
still write legacy cache entries into shared workspaces; keep them closed
and replace the launcher target, not only a downloaded copy elsewhere.

Regression coverage:

- `cargo test --manifest-path apps/server-rs/Cargo.toml pch_` uses real C and
  C++ PCHs to check relocation, legacy stamps, unchanged cache reuse, and
  incomplete cache rejection.
- `pnpm cfamily:test` checks instrumented source, including compilation of
  output statements inside C++ `try/catch` blocks.

Never delete a workspace to repair a PCH. On an updated build, rerunning the
program regenerates an invalid cache without changing the source files.
