# Atomis in a container.
#
# The image carries the toolchains, which is the tedious half of running this
# yourself: zig and zls pinned by version, plus rust, go, node, python and
# clang. Atomis never downloads a toolchain at runtime — what is here is what
# your sessions can use, and `pnpm run doctor` reports the rest as degraded.
#
# Two things to know before you run it:
#
#   * This server runs whatever code is sent to it, as the container user. The
#     container is the boundary; do not mount anything into it you would mind
#     a stranger reading.
#   * The Landlock sandbox needs Linux 6.7+ on the *host*, and a seccomp
#     profile that permits landlock_* syscalls. Without it sessions still run,
#     unconfined within the container — the doctor says which you have.

# ── build ────────────────────────────────────────────────────────────────
FROM rust:1.96-bookworm AS build

ARG ZIG_VERSION=0.16.0
ARG ZLS_VERSION=0.16.0

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl xz-utils ca-certificates git golang-go clang \
    && rm -rf /var/lib/apt/lists/*

# Node via the distro's nodesource-free route: the pinned tarball, so the
# build does not depend on a repo that moves.
ARG NODE_VERSION=22.14.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && corepack enable

RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
      | tar -xJ -C /opt && ln -s "/opt/zig-x86_64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig

WORKDIR /src
COPY . .
RUN corepack prepare --activate && pnpm install --frozen-lockfile && pnpm build

# pnpm links packages into a content store, and COPY --from copies a symlink
# as a symlink — which would arrive in the runtime image pointing at nothing.
RUN cp -rL /src/node_modules/typescript /opt/typescript

# ── run ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ARG ZIG_VERSION=0.16.0
ARG NODE_VERSION=22.14.0

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils golang-go clang python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/zig-x86_64-linux-${ZIG_VERSION} /opt/zig
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN ln -s /opt/zig/zig /usr/local/bin/zig

# The app: the server binary, the built UI, and the instrumenters and
# templates it reads at runtime through ATOMIS_ROOT.
WORKDIR /app
COPY --from=build /src/apps/server-rs/target/release/atomis-server /usr/local/bin/atomis-server
COPY --from=build /src/apps/web/dist /app/apps/web/dist
COPY --from=build /src/zig-out /app/zig-out
COPY --from=build /src/rust/instrumenter/target/release/rustlive-instrument /app/rust/instrumenter/target/release/rustlive-instrument
COPY --from=build /src/go/instrumenter/bin /app/go/instrumenter/bin
# Whole language directories rather than a list of files: each holds an
# instrumenter, a runtime shim, a session template and sometimes a test
# runner, and the server opens all of them by path. `rust/` is the exception
# — its build directory is enormous, so only the binary comes across.
COPY --from=build /src/zig /app/zig
COPY --from=build /src/ts /app/ts
COPY --from=build /src/python /app/python
COPY --from=build /src/cfamily /app/cfamily
COPY --from=build /src/go/runtime /app/go/runtime
COPY --from=build /src/go/session-template /app/go/session-template
COPY --from=build /src/rust/runtime /app/rust/runtime
COPY --from=build /src/rust/session-template /app/rust/session-template
# TypeScript sessions type-check with this exact tsc, found by path.
COPY --from=build /opt/typescript /app/node_modules/typescript
COPY --from=build /src/build.zig /src/build.zig.zon /app/

# Not root: this process runs other people's code.
RUN useradd --create-home --uid 10001 atomis \
    && mkdir -p /data && chown -R atomis /data /app
USER atomis

ENV NODE_ENV=production \
    ATOMIS_ROOT=/app \
    ATOMIS_PORT=4317 \
    ATOMIS_HOST=0.0.0.0 \
    XDG_DATA_HOME=/data \
    XDG_CACHE_HOME=/data/cache

# Workspaces, preferences and the compiler cache. Mount it to keep them.
VOLUME ["/data"]
EXPOSE 4317

# ATOMIS_TOKEN has no default on purpose: the server refuses to listen on
# 0.0.0.0 without one, so a container cannot come up open by accident.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS http://127.0.0.1:4317/api/health || exit 1

ENTRYPOINT ["atomis-server"]
