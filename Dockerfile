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

# Every download below is pinned by version AND by sha256: a tarball that a
# mirror or a MITM alters fails the build instead of entering the image.
ARG ZIG_VERSION=0.16.0
ARG ZIG_SHA256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
# Same tarball + hash .github/workflows/ci.yml pins for the e2e job.
ARG ZLS_VERSION=0.16.0
ARG ZLS_SHA256=ded6d562a0b86ee878b1ddf70ffab2797ce3cdca3b02d6077548f9d56dff96b6
ARG NODE_VERSION=22.14.0
ARG NODE_SHA256=69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec
# The official tarball, not bookworm's golang-go: the distro ships 1.19 and
# the go.mod files declare `go 1.22`, which 1.19 refuses to build.
ARG GO_VERSION=1.22.12
ARG GO_SHA256=4fa4f869b0f7fc6bb1eb2660e74657fbf04cdd290b5aef905585c86051b34d43
ARG UV_VERSION=0.12.7
ARG UV_SHA256=788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl xz-utils ca-certificates git clang \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz \
    && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
    && tar -xzf /tmp/go.tgz -C /usr/local && rm /tmp/go.tgz \
    && ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# Node via the pinned tarball, so the build does not depend on a repo that
# moves. The tarball ships npm/npx under lib/node_modules — kept, because
# the Dependencies tab for TS sessions runs `npm install`.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.txz \
    && echo "${NODE_SHA256}  /tmp/node.txz" | sha256sum -c - \
    && tar -xJf /tmp/node.txz -C /usr/local --strip-components=1 && rm /tmp/node.txz \
    && corepack enable

RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.txz \
    && echo "${ZIG_SHA256}  /tmp/zig.txz" | sha256sum -c - \
    && tar -xJf /tmp/zig.txz -C /opt && rm /tmp/zig.txz \
    && ln -s "/opt/zig-x86_64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig

RUN curl -fsSL "https://builds.zigtools.org/zls-x86_64-linux-${ZLS_VERSION}.tar.xz" -o /tmp/zls.txz \
    && echo "${ZLS_SHA256}  /tmp/zls.txz" | sha256sum -c - \
    && tar -xJf /tmp/zls.txz -C /usr/local/bin zls \
    && chmod +x /usr/local/bin/zls && rm /tmp/zls.txz

# uv resolves and installs Python dependencies into each workspace's venv.
RUN curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tgz \
    && echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c - \
    && tar -xzf /tmp/uv.tgz -C /tmp \
    && mv /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/ \
    && rm -rf /tmp/uv.tgz /tmp/uv-x86_64-unknown-linux-gnu

# The LSP servers the editor speaks to. rust-analyzer rides the toolchain
# (rustup proxies it through /usr/local/cargo/bin); the TS and Python ones
# land in /usr/local/lib/node_modules beside npm.
RUN rustup component add rust-analyzer \
    && npm install -g typescript-language-server@6.0.0 pyright@1.1.413

WORKDIR /src
COPY . .
RUN corepack prepare --activate && pnpm install --frozen-lockfile && pnpm build

# pnpm links packages into a content store, and COPY --from copies a symlink
# as a symlink — which would arrive in the runtime image pointing at nothing.
RUN cp -rL /src/node_modules/typescript /opt/typescript

# ── run ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ARG ZIG_VERSION=0.16.0

# clangd comes from apt like clang so the pair always match; curl stays for
# the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils clang clangd python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Toolchains, copied from the build stage rather than reinstalled — each one
# was downloaded (and checksummed) exactly once.
COPY --from=build /opt/zig-x86_64-linux-${ZIG_VERSION} /opt/zig
COPY --from=build /usr/local/go /usr/local/go
# The full Rust toolchain: without rustc/cargo every Rust session died at
# its first compile, despite the header up top promising Rust. rust-analyzer
# is a rustup component, reached through the cargo bin proxies.
COPY --from=build /usr/local/rustup /usr/local/rustup
COPY --from=build /usr/local/cargo /usr/local/cargo
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/bin/zls /usr/local/bin/zls
COPY --from=build /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/
# npm/npx and the global language servers live inside this tree; the bin
# entries below are relative symlinks into it and survive the copy as links.
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/typescript-language-server \
    /usr/local/bin/pyright \
    /usr/local/bin/pyright-langserver \
    /usr/local/bin/
RUN ln -s /opt/zig/zig /usr/local/bin/zig \
    && ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt

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

# RUSTUP_HOME/CARGO_HOME point cargo's rustup proxies at the copied
# toolchain; sessions override CARGO_HOME per workspace for their own
# registries, which only ever needs these directories read-only.
ENV NODE_ENV=production \
    ATOMIS_ROOT=/app \
    ATOMIS_PORT=4317 \
    ATOMIS_HOST=0.0.0.0 \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    XDG_DATA_HOME=/data \
    XDG_CACHE_HOME=/data/cache

# Workspaces, preferences and the compiler cache. Mount it to keep them.
VOLUME ["/data"]
EXPOSE 4317

# ATOMIS_TOKEN has no default on purpose: the server refuses to listen on
# 0.0.0.0 without one, so a container cannot come up open by accident.
# Shell form so the check follows ATOMIS_PORT when the operator moves it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS "http://127.0.0.1:${ATOMIS_PORT:-4317}/api/health" || exit 1

ENTRYPOINT ["atomis-server"]
