# syntax=docker/dockerfile:1

# Neuro OJ noj-judge 生产镜像（多阶段）
#
# 目标：最终镜像只保留 release 二进制与运行必需文件（ca-certificates），
# 不包含 Rust 工具链、target/、测试源码。
#
# 平台：linux/amd64（公测阶段只支持 amd64）。
#
# 注意：生产 Compose 只挂载独立 rootless Docker daemon 的 Unix socket，
# Worker 使用非 root 用户运行；禁止挂载应用宿主机的 /var/run/docker.sock。

# ── Builder：编译 release 二进制 ────────────────────────────────────
FROM rust:1.86-slim-bookworm AS builder

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

# ── Runtime：只保留二进制 ───────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates：支持包/预签名 URL 的 HTTPS 下载
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 10001 noj \
    && adduser --system --uid 10001 --gid 10001 --no-create-home noj \
    && mkdir -p /run/noj-judge \
    && chown noj:noj /run/noj-judge

COPY --from=builder /tmp/noj-judge /usr/local/bin/noj-judge

USER 10001:10001

# 无 HTTP 端口；健康检查直接探测 PID 1 是否存活（shell 形式）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD kill -0 1 || exit 1

ENTRYPOINT ["noj-judge"]
