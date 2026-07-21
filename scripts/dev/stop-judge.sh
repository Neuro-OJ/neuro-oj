#!/usr/bin/env bash
#
# 停止 noj-judge
#
# 使用: bash scripts/dev/stop-judge.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$LOG_DIR/judge.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "noj-judge 未在运行(无 PID 文件)"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if ! kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID 已不存在,清理 PID 文件"
  rm -f "$PID_FILE"
  exit 0
fi

echo ">>> 停止 noj-judge(PID $PID)..."
kill -INT "$PID"  # cargo run 转发 SIGINT 给 rust 程序,触发 ctrl_c() 优雅关闭

for i in {1..10}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "✓ noj-judge 已停止"
    exit 0
  fi
  sleep 1
done

echo "进程未响应 SIGINT,发送 SIGTERM"
kill -TERM "$PID" 2>/dev/null || true
sleep 2

if kill -0 "$PID" 2>/dev/null; then
  echo "仍未退出,发送 SIGKILL"
  kill -KILL "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "✓ noj-judge 已停止"