#!/bin/sh
# E2E entrypoint — 接受 MODE 参数让 docker compose 做工作拆分
#
# 用法（由 docker-compose.e2e.yml 调用）：
#   - 不传参（默认 serve）：只跑 HTTP server
#   - migrate: 只跑数据库迁移（noj db migrate）
#   - setup:   dev-setup 后退出（CI 用作 one-shot 准备步骤）
#
# 这样 noj-core 容器启动 ~4s（vs 之前 25-30 min 在容器里跑 migrate+seed），
# 单 PR Full Pipeline 时间从 10-30 min 降到 4-6 min。
set -e

MODE=${1:-serve}

case "$MODE" in
  migrate)
    echo ">>> Running database migrations..."
    exec deno task db:migrate
    ;;
  setup)
    echo ">>> Running dev-setup (migrate + init + problems)..."
    exec deno task dev-setup
    ;;
  serve|*)
    # v13 fix：放弃 deno compile AOT（Alpine musl vs glibc binary 兼容性
    # 问题过多）。改用 deno cache 预热 + deno task start 启动 server。
    # 冷启动 ~4s（之前实测 25-30 min）。
    echo ">>> Starting noj-core API server (deno task start)..."
    exec deno task start
    ;;
esac
