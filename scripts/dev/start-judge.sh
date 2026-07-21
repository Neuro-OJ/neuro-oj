#!/usr/bin/env bash
#
# 启动 noj-judge(评测 Worker)
#
# 后台运行,日志写入 scripts/dev/logs/judge.log
# PID 写入 scripts/dev/logs/judge.pid
#
# 使用: bash scripts/dev/start-judge.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
JUDGE_DIR="$REPO_ROOT/noj-judge"
PID_FILE="$LOG_DIR/judge.pid"
LOG_FILE="$LOG_DIR/judge.log"

mkdir -p "$LOG_DIR"

# ── 守护:已在运行则跳过 ────────────────────────────────────
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "noj-judge 已在运行(PID $(cat "$PID_FILE"))"
  echo "查看日志: tail -f $LOG_FILE"
  exit 0
fi
rm -f "$PID_FILE"

# ── 前置检查 ────────────────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
  echo "错误: 未检测到 cargo,请先安装 Rust 工具链"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "错误: Docker daemon 未运行,noj-judge 需要 Docker 沙箱"
  exit 1
fi

# 镜像白名单通过 Redis RPC 从 noj-core 获取,故需 core 至少初始化过
if ! docker compose -f "$REPO_ROOT/docker-compose.yml" ps --status running 2>/dev/null | grep -qE 'redis'; then
  echo "警告: Redis 未运行,启动后 RPC 通信将失败"
fi

# ── 启动 ────────────────────────────────────────────────────
cd "$JUDGE_DIR"

# 若未编译,先编译(首次启动较慢)
if [[ ! -f target/debug/noj-judge && ! -f target/release/noj-judge ]]; then
  echo ">>> 首次启动,正在编译 noj-judge(约 1-3 分钟)..."
  cargo build
fi

echo ">>> 启动 noj-judge(日志: $LOG_FILE)..."

# default 环境变量(noj-judge 默认连 localhost:6379)
nohup cargo run >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

# ── 等待就绪:监听 Redis 队列 BRPOP ──────────────────────────
echo ">>> 等待 Redis 队列就绪..."
for i in {1..30}; do
  if grep -q "Connected to Redis\|listening\|等待\|Waiting\|ready\|pool_init\|initialized" "$LOG_FILE" 2>/dev/null; then
    echo ""
    echo "✓ noj-judge 已启动"
    echo "  PID:    $PID"
    echo "  队列:   noj:judge:queue(默认)"
    echo "  日志:   tail -f $LOG_FILE"
    echo "  停止:   bash scripts/dev/stop-judge.sh"
    exit 0
  fi
  # 启动失败:进程已退出
  if ! kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "✗ noj-judge 启动失败,请查看日志: $LOG_FILE"
    tail -30 "$LOG_FILE" || true
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 1
done

# 超时但进程仍在运行,标记为已启动(可能还在预热容器)
echo ""
echo "✓ noj-judge 进程已运行(PID $PID),请通过日志确认队列监听状态"
echo "  日志: tail -f $LOG_FILE"