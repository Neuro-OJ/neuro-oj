#!/usr/bin/env bash
#
# E2E 一键运行脚本
# 1. 环境启动（setup.sh — docker compose 拉起完整评测栈）
# 2. 运行所有测试套件：core → judge
# 3. 环境停止（teardown.sh — docker compose down -v）
#
# 使用方法: bash scripts/e2e/run-all.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=========================================="
echo " Neuro OJ — E2E 测试套件"
echo "=========================================="
echo ""

# ── Step 1: 环境启动 ──
echo ">>> [1/3] 启动 E2E 环境..."
bash "$ROOT_DIR/scripts/e2e/setup.sh"

echo ""
echo ">>> [2/3] 运行所有测试..."
echo ""

# ── Step 2: 运行所有测试 ──
PASS=0
FAIL=0
REPORT=""

run_test() {
  local name="$1"
  local cmd="$2"
  echo "=========================================="
  echo " 套件: $name"
  echo "=========================================="
  set +e
  eval "$cmd"
  local exit_code=$?
  set -e
  if [ $exit_code -eq 0 ]; then
    REPORT="${REPORT}$(printf "  %-30s  %s\n" "$name" "✅ 通过")\n"
    PASS=$((PASS + 1))
  else
    REPORT="${REPORT}$(printf "  %-30s  %s\n" "$name" "❌ 失败")\n"
    FAIL=$((FAIL + 1))
  fi
  echo ""
}

# core + judge: 依赖 setup.sh 导出的环境变量
run_test "noj-core E2E" "bash $ROOT_DIR/scripts/e2e/core.sh"
run_test "noj-judge E2E" "bash $ROOT_DIR/scripts/e2e/judge.sh"

# ── Step 3: 环境停止 ──
echo ">>> [3/3] 停止 E2E 环境..."
bash "$ROOT_DIR/scripts/e2e/teardown.sh"

# ── 汇总 ──
echo "=========================================="
echo " E2E 测试报告"
echo "=========================================="
echo ""
printf "%b" "$REPORT"
echo ""
echo "总计: $((PASS + FAIL))  |  通过: $PASS  |  失败: $FAIL"
echo "=========================================="

exit $([ "$FAIL" -gt 0 ] && echo 1 || echo 0)
