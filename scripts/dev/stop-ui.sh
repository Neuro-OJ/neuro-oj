#!/usr/bin/env bash
#
# 停止 noj-ui
#
# 使用: bash scripts/dev/stop-ui.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$LOG_DIR/ui.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "noj-ui 未在运行(无 PID 文件)"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID 已不存在,清理 PID 文件"
  rm -f "$PID_FILE"
  exit 0
fi

echo ">>> 停止 noj-ui(PID $PID)..."
kill -TERM "$PID"

for i in {1..10}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "✓ noj-ui 已停止"
    exit 0
  fi
  sleep 1
done

echo "进程未响应 SIGTERM,发送 SIGKILL"
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "✓ noj-ui 已强制停止"