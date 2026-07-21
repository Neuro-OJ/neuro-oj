#!/usr/bin/env bash
#
# 查看 NOJ 各模块运行状态
#
# 显示:
# - 基础设施容器(PostgreSQL / Redis)
# - noj-core / noj-ui / noj-judge 进程
# - 端口监听情况
# - 日志文件路径
#
# 使用: bash scripts/dev/status.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"

# 颜色
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; DIM='\033[2m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; DIM=''; RESET=''
fi

ok()   { printf "${GREEN}●${RESET} %s\n" "$*"; }
down() { printf "${RED}●${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}●${RESET} %s\n" "$*"; }

read_pid() {
  local pid_file="$LOG_DIR/$1.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  echo ""
}

# ── 基础设施 ────────────────────────────────────────────────
echo "━━━ 基础设施 ━━━"

if command -v docker >/dev/null 2>&1; then
  if docker compose -f "$REPO_ROOT/docker-compose.yml" ps --status running 2>/dev/null | grep -qE 'postgres|redis'; then
    docker compose -f "$REPO_ROOT/docker-compose.yml" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null \
      | grep -E 'postgres|redis|NAME' || true
  else
    down "未运行(运行 bash scripts/dev/start-infra.sh 启动)"
  fi
else
  warn "docker 命令不可用"
fi

echo ""

# ── noj-core ────────────────────────────────────────────────
echo "━━━ noj-core(端口 8000)━━━"
CORE_PID="$(read_pid core)"
if [[ -n "$CORE_PID" ]]; then
  ok "运行中 (PID $CORE_PID)"
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
    printf "  ${GREEN}health OK${RESET}\n"
  else
    printf "  ${YELLOW}health 不可达${RESET}\n"
  fi
  printf "  日志: %s/core.log\n" "$LOG_DIR"
else
  down "未运行"
fi
echo ""

# ── noj-ui ──────────────────────────────────────────────────
echo "━━━ noj-ui(端口 3000)━━━"
UI_PID="$(read_pid ui)"
if [[ -n "$UI_PID" ]]; then
  ok "运行中 (PID $UI_PID)"
  if curl -fsS -o /dev/null http://localhost:3000/ 2>/dev/null; then
    printf "  ${GREEN}HTTP OK${RESET}\n"
  else
    printf "  ${YELLOW}端口不可达${RESET}\n"
  fi
  printf "  日志: %s/ui.log\n" "$LOG_DIR"
else
  down "未运行"
fi
echo ""

# ── noj-judge ───────────────────────────────────────────────
echo "━━━ noj-judge(无 HTTP)━━━"
JUDGE_PID="$(read_pid judge)"
if [[ -n "$JUDGE_PID" ]]; then
  ok "运行中 (PID $JUDGE_PID)"
  # 检查 Redis 队列监听状态
  if command -v docker >/dev/null 2>&1 && docker compose -f "$REPO_ROOT/docker-compose.yml" ps --status running 2>/dev/null | grep -q redis; then
    QUEUE_LEN="$(docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T redis redis-cli LLEN noj:judge:queue 2>/dev/null | tr -d '\r')"
    printf "  任务队列长度: %s\n" "${QUEUE_LEN:-?}"
  fi
  printf "  日志: %s/judge.log\n" "$LOG_DIR"
else
  down "未运行"
fi
echo ""

# ── 日志目录 ────────────────────────────────────────────────
echo "━━━ 日志 ${DIM}(scripts/dev/logs/)${RESET} ━━━"
if [[ -d "$LOG_DIR" ]]; then
  ls -lh "$LOG_DIR"/*.log 2>/dev/null | awk '{printf "  %-15s  %s\n", $NF, $5}' || echo "  无日志文件"
fi