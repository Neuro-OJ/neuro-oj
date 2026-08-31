# syntax=docker/dockerfile:1

# Neuro OJ noj-server 生产镜像（多阶段）
#
# 目标：最终镜像只包含 deno compile 出的独立二进制 + 运行必需文件
# （drizzle 迁移、data 题目源等），不包含 Deno 工具链、源码与开发依赖。
#
# 平台：linux/amd64（公测阶段只支持 amd64）。

# ── Builder：安装依赖并编译两个二进制 ─────────────────────────────
FROM denoland/deno:debian-2.9.5@sha256:5d46f925d213e9adaf18a0664b291fe973c91ba7b929572877610dcaaf09ee2b AS builder

WORKDIR /build

# 先复制依赖清单，利用 Docker 层缓存
COPY deno.json deno.lock* package.json* ./
# deno install 会下载大量 npm 包，网络抖动时容易失败；增加重试
RUN for i in 1 2 3 4 5; do \
      if deno install 2>&1; then exit 0; fi; \
      echo "deno install failed (attempt $i/5), retrying..."; \
      sleep 5; \
    done; \
    echo "ERROR: deno install failed after 5 attempts" >&2; \
    exit 1;

# 复制源码、脚本、迁移与题目数据
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY data/ ./data/
COPY drizzle.config.ts ./
COPY drizzle/ ./drizzle/

# 预热 import 链，加速 compile
RUN deno cache \
      scripts/migrate.ts \
      scripts/noj.ts \
      src/main.ts \
      --no-lock 2>&1 || { echo "ERROR: deno cache warmup failed" >&2; exit 1; }

# 编译 API server 与 CLI 两个独立二进制
RUN mkdir -p /build/bin \
    && deno compile -A --no-check --unstable-byonm --unstable-node-globals \
        --output /build/bin/noj-server src/main.ts \
    && deno compile -A --no-check --unstable-byonm --unstable-node-globals \
        --output /build/bin/noj scripts/noj.ts

# ── Runtime：只保留二进制与必需文件 ────────────────────────────────
FROM debian:bookworm-slim@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867

# ca-certificates：HTTPS 出站；zip：problems:build；wget：healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        zip \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 创建非 root 用户
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin noj

# 只复制二进制、迁移文件和题目数据目录
COPY --from=builder --chown=noj:noj /build/bin/ /app/bin/
COPY --from=builder --chown=noj:noj /build/drizzle/ /app/drizzle/
COPY --from=builder --chown=noj:noj /build/data/ /app/data/

# 确保数据子目录存在（Compose 会挂载匿名卷到 packages/storage）
RUN mkdir -p /app/data/packages /app/data/storage \
    && chown -R noj:noj /app

# deno compile 后 import.meta.dirname 指向临时解包目录，必须显式指定项目根/迁移目录
ENV NOJ_PROJECT_ROOT=/app
ENV NOJ_MIGRATIONS_DIR=/app/drizzle

USER noj

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/health >/dev/null 2>&1 || exit 1

CMD ["/app/bin/noj-server"]
