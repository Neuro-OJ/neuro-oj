# syntax=docker/dockerfile:1

# Neuro OJ noj-judge 生产镜像（多阶段）
#
# 目标：最终镜像保留 release 二进制、固定 WASI SDK 与运行必需文件，
# 不包含 Rust 工具链、target/、测试源码。
#
# 平台：linux/amd64（公测阶段只支持 amd64）。
#
# 注意：生产 Compose 只挂载独立 rootless Docker daemon 的 Unix socket，
# Worker 使用非 root 用户运行；禁止挂载应用宿主机的 /var/run/docker.sock。

# ── WASI SDK：官方固定版本，下载内容必须匹配摘要 ────────────────────
FROM debian:bookworm-slim@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867 AS wasi-sdk
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl --fail --location --retry 3 \
       https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz \
       -o /tmp/wasi-sdk.tar.gz \
    && echo 'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4  /tmp/wasi-sdk.tar.gz' | sha256sum --check - \
    && mkdir -p /opt/wasi-sdk \
    && tar -xzf /tmp/wasi-sdk.tar.gz --strip-components=1 --no-same-owner -C /opt/wasi-sdk \
    && rm -f /tmp/wasi-sdk.tar.gz

# ── Builder：编译 release 二进制 ────────────────────────────────────
# Wasmtime 49 要求 Rust 1.96+；与 rust-toolchain.toml 保持同一工具链版本。
FROM rust:1.96.1-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3 AS builder

WORKDIR /build

# 第 1 层：只编译依赖（Cargo.lock 不变即缓存命中）
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && \
    cargo build --release --bin noj-judge 2>&1 && \
    rm -f target/release/noj-judge

# 第 2 层：只编译业务代码
COPY src/ ./src/
RUN cargo build --release --bin noj-judge && \
    cp /build/target/release/noj-judge /tmp/noj-judge && \
    test -f /tmp/noj-judge || { echo "ERROR: binary not found after build" >&2; exit 1; }

# ── Runtime：评测二进制与受限 WASI 编译工具链 ───────────────────────
FROM debian:bookworm-slim@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867 AS wasi-runtime

# ca-certificates：支持包/预签名 URL 的 HTTPS 下载
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libtinfo6 \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 10001 noj \
    && adduser --system --uid 10001 --gid 10001 --no-create-home noj \
    && mkdir -p /run/noj-judge \
    && chown noj:noj /run/noj-judge

COPY --from=wasi-sdk /opt/wasi-sdk /opt/wasi-sdk
ENV JUDGE_WASI_CC=/opt/wasi-sdk/bin/clang \
    JUDGE_WASI_CXX=/opt/wasi-sdk/bin/clang++ \
    JUDGE_WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot \
    JUDGE_WASI_TARGET=wasm32-wasip1

FROM wasi-runtime AS runtime
COPY --from=builder /tmp/noj-judge /usr/local/bin/noj-judge

USER 10001:10001

# 无 HTTP 端口；健康检查直接探测 PID 1 是否存活（shell 形式）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD kill -0 1 || exit 1

ENTRYPOINT ["noj-judge"]
