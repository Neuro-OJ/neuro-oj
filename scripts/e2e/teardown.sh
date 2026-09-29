#!/usr/bin/env bash
#
# E2E 环境停止脚本
# 使用 Docker Compose 停止并清理评测栈
#
# 使用方法: bash scripts/e2e/teardown.sh

source "$(dirname "$0")/lib.sh"

# 独立 compose 项目名（本仓约定，务必保留）：
# e2e 与 dev 的 compose 文件都含 postgres/redis/minio 服务，而两份文件**都没有顶层 `name:`**
# → 默认项目名都取所在目录名（仓库根）→ 同为 `neuro-oj`。于是 `up` 会把 dev 的
# noj-postgres/redis/minio 当成"本项目的同名服务"**认领并重建**为 noj-e2e-*
# （2026-09-28 实测发生：dev 数据库/Redis/MinIO 被顶掉；`down -v` 更会删除项目内卷）。
# CI 侧早已用 COMPOSE_PROJECT_NAME 隔离（.github/workflows/e2e.yml:57），**本地此前没有保护**。
# 这里补上；需要与其它 stack 并存时可显式覆盖该变量。
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-noj-e2e-local}"

echo ""
echo -e "${BOLD}=========================================="
echo " Neuro OJ — E2E 环境停止"
echo -e "==========================================${NC}"
echo ""

# ── 停止 Docker Compose 评测栈 ──
if [ -z "${CI:-}" ]; then
  if [ -f "$ROOT_DIR/docker-compose.e2e.yml" ]; then
    info "停止并清理 Docker Compose 评测栈..."
    docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" down -v
    ok "评测栈已停止并清理"
  fi
else
  ok "CI 环境检测，跳过 Docker Compose 停止"
fi

# ── 清理临时文件 ──
rm -f /tmp/noj-e2e-env.sh

echo ""
echo -e "${BOLD}E2E 环境已停止${NC}"
echo ""
