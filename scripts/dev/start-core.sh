#!/usr/bin/env bash
#
# 启动 noj-core(后端 Deno 服务)
#
# 后台运行,日志写入 scripts/dev/logs/core.log
# PID 写入 scripts/dev/logs/core.pid
#
# 使用: bash scripts/dev/start-core.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
CORE_DIR="$REPO_ROOT/noj-core"
PID_FILE="$LOG_DIR/core.pid"
LOG_FILE="$LOG_DIR/core.log"

mkdir -p "$LOG_DIR"

# ── 守护:已在运行则跳过 ────────────────────────────────────
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "noj-core 已在运行(PID $(cat "$PID_FILE"))"
  echo "查看日志: tail -f $LOG_FILE"
  exit 0
fi
rm -f "$PID_FILE"

# ── 检查 .env ────────────────────────────────────────────────
if [[ ! -f "$CORE_DIR/.env" ]]; then
  echo "错误: $CORE_DIR/.env 不存在"
  echo "请先复制模板: cp $SCRIPT_DIR/env.example $CORE_DIR/.env"
  echo "并填写 DATABASE_URL / JWT_SECRET 等必填项"
  exit 1
fi

# ── 检查基础设施 ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "错误: 未检测到 docker"
  exit 1
fi
if ! docker compose -f "$REPO_ROOT/docker-compose.yml" ps --status running 2>/dev/null | grep -qE 'postgres|redis'; then
  echo "警告: 基础设施可能未启动,先运行: bash scripts/dev/start-infra.sh"
fi

# ── 启动 ────────────────────────────────────────────────────
cd "$CORE_DIR"

echo ">>> 启动 noj-core(端口 8000,日志: $LOG_FILE)..."

# nohup + & 脱离当前会话,2>&1 合并 stderr
nohup deno task dev >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

# ── 等待就绪(健康检查) ──────────────────────────────────────
echo ">>> 等待 HTTP 服务就绪..."
for i in {1..30}; do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
    echo ""
    echo "✓ noj-core 已启动"
    echo "  PID:      $PID"
    echo "  端口:     8000"
    echo "  健康检查: curl http://localhost:8000/health"
    echo "  日志:     tail -f $LOG_FILE"
    echo "  停止:     bash scripts/dev/stop-core.sh"
    exit 0
  fi
  sleep 1
done

# 启动失败
echo ""
echo "✗ noj-core 启动超时,请查看日志: $LOG_FILE"
tail -20 "$LOG_FILE" || true
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1