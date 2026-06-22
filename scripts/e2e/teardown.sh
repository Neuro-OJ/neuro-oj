#!/usr/bin/env bash
#
# E2E 环境停止脚本
# 使用 Docker Compose 停止并清理评测栈
#
# 使用方法: bash scripts/e2e/teardown.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

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
