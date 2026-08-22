# syntax=docker/dockerfile:1

# Neuro OJ noj-ui 生产镜像（多阶段）
#
# 目标：最终镜像只包含 deno compile 出的单二进制（内含 .output/public），
# 不包含源码、node_modules、Nuxt 工具链。
#
# 平台：linux/amd64（公测阶段只支持 amd64）。

# ── Builder：安装依赖并编译单二进制 ────────────────────────────────
FROM denoland/deno:debian-2.9.5 AS builder

WORKDIR /build

# 先复制依赖清单，利用 Docker 层缓存
COPY package.json deno.json deno.lock* pnpm-workspace.yaml ./
# deno install 会下载大量 npm 包，网络抖动时容易失败；增加重试
RUN for i in 1 2 3 4 5; do \
      if deno install 2>&1; then exit 0; fi; \
      echo "deno install failed (attempt $i/5), retrying..."; \
      sleep 5; \
    done; \
    echo "ERROR: deno install failed after 5 attempts" >&2; \
    exit 1;

# 复制源码（.dockerignore 会排除 node_modules/.nuxt/.output/dist 等）
COPY . .

# 构建前修补 Monaco 内置 workerManager，避免 Vite/Rolldown worker 插件报错
RUN deno run -A scripts/patch-monaco-workers.mjs

# 编译为单二进制：deno task compile 会先执行 nuxt build，再 deno compile
RUN deno task compile 2>&1 || { echo "ERROR: noj-ui compile failed" >&2; exit 1; }

# ── Runtime：只保留二进制 ───────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates：HTTPS 出站；wget：healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 创建非 root 用户
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin noj

COPY --from=builder --chown=noj:noj /build/dist/noj-ui /app/noj-ui
RUN chmod +x /app/noj-ui

USER noj

ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

CMD ["./noj-ui"]
