#!/usr/bin/env bash
#
# 启动 noj-ui(前端 Nuxt 服务)
#
# 后台运行,日志写入 scripts/dev/logs/ui.log
# PID 写入 scripts/dev/logs/ui.pid
#
# 使用: bash scripts/dev/start-ui.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
UI_DIR="$REPO_ROOT/noj-ui"
PID_FILE="$LOG_DIR/ui.pid"
LOG_FILE="$LOG_DIR/ui.log"

mkdir -p "$LOG_DIR"

# ── 守护:已在运行则跳过 ────────────────────────────────────
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "noj-ui 已在运行(PID $(cat "$PID_FILE"))"
  echo "查看日志: tail -f $LOG_FILE"
  exit 0
fi
rm -f "$PID_FILE"

# ── 启动 ────────────────────────────────────────────────────
cd "$UI_DIR"

echo ">>> 启动 noj-ui(端口 3000,日志: $LOG_FILE)..."
echo "    首次启动可能需要 10-30s 进行依赖准备"

nohup deno task dev >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

# ── 等待端口就绪 ────────────────────────────────────────────
echo ">>> 等待 HTTP 服务就绪..."
for i in {1..60}; do
  if curl -fsS -o /dev/null http://localhost:3000/ 2>/dev/null; then
    echo ""
    echo "✓ noj-ui 已启动"
    echo "  PID:      $PID"
    echo "  端口:     3000"
    echo "  访问:     http://localhost:3000"
    echo "  日志:     tail -f $LOG_FILE"
    echo "  停止:     bash scripts/dev/stop-ui.sh"
    exit 0
  fi
  sleep 1
done

echo ""
echo "✗ noj-ui 启动超时,请查看日志: $LOG_FILE"
tail -30 "$LOG_FILE" || true
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1