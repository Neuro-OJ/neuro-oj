#!/usr/bin/env bash
#
# E2E 环境停止脚本
# 停止 setup.sh 启动的所有服务，清理容器
#
# 使用方法: bash scripts/e2e/teardown.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source /tmp/noj-e2e-env.sh 2>/dev/null || true

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

echo ""
echo -e "${BOLD}=========================================="
echo " Neuro OJ — E2E 环境停止"
echo -e "==========================================${NC}"
echo ""

# ── 停止 noj-judge ──
if [ -f /tmp/noj-e2e-judge.pid ]; then
  PID=$(cat /tmp/noj-e2e-judge.pid)
  if kill "$PID" 2>/dev/null; then
    ok "noj-judge (PID $PID) 已停止"
  else
    info "noj-judge 未在运行"
  fi
  rm -f /tmp/noj-e2e-judge.pid
fi

# ── 停止 noj-core ──
if [ -f /tmp/noj-e2e-core.pid ]; then
  PID=$(cat /tmp/noj-e2e-core.pid)
  if kill "$PID" 2>/dev/null; then
    ok "noj-core (PID $PID) 已停止"
  else
    info "noj-core 未在运行"
  fi
  rm -f /tmp/noj-e2e-core.pid
fi

# ── 停止 noj-ui（如果 setup.sh 启动了的话） ──
if [ -f /tmp/noj-e2e-ui.pid ]; then
  PID=$(cat /tmp/noj-e2e-ui.pid)
  if kill "$PID" 2>/dev/null; then
    ok "noj-ui (PID $PID) 已停止"
  else
    info "noj-ui 未在运行"
  fi
  rm -f /tmp/noj-e2e-ui.pid
fi

# ── 停止 Docker 容器 ──
if docker ps --format '{{.Names}}' | grep -q '^noj-e2e-postgres$'; then
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" stop postgres
  ok "noj-e2e-postgres 已停止"
fi

if docker ps --format '{{.Names}}' | grep -q '^noj-e2e-redis$'; then
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" stop redis
  ok "noj-e2e-redis 已停止"
fi

# ── 清理临时文件 ──
rm -f /tmp/noj-e2e-env.sh /tmp/noj-e2e-core.log /tmp/noj-e2e-judge.log

echo ""
echo -e "${BOLD}E2E 环境已停止${NC}"
echo ""
