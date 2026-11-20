#!/usr/bin/env bash
#
# E2E 一键运行脚本（P6-B：会话私有）
# 1. 创建/启动会话（session.ts up）
# 2. 运行 core → judge 套件
# 3. 停止会话（session.ts down，所有权校验后只删本会话资源）
#
# 用法: bash scripts/e2e/run-all.sh [--session <name>] [--fresh]

source "$(dirname "$0")/lib.sh"

SESSION=""
FRESH_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --session)
      SESSION="${2:-}"
      shift 2
      ;;
    --fresh)
      FRESH_ARGS=(--fresh)
      shift
      ;;
    *)
      fail "未知参数: $1"
      exit 2
      ;;
  esac
done

# 默认会话名带时间戳：并行跑 run-all 不会撞名。
SESSION="${SESSION:-run-all-$(date +%Y%m%d-%H%M%S)}"

cd "$ROOT_DIR"

echo "=========================================="
echo " Neuro OJ — E2E 测试套件（session: $SESSION）"
echo "=========================================="
echo ""

cleanup() {
  echo ""
  info "清理会话 $SESSION ..."
  deno run -A scripts/e2e/session.ts down --session "$SESSION" || \
    warn "会话清理失败：清单已保留，可手动重试"
}
trap cleanup EXIT

# ── Step 1: 环境启动 ──
echo ">>> [1/3] 启动 E2E 会话..."
# 空数组在 set -u 下展开需加保护（bash 3.2 / macOS 兼容）。
if ! deno run -A scripts/e2e/session.ts up --session "$SESSION" \
    ${FRESH_ARGS[@]+"${FRESH_ARGS[@]}"}; then
  fail "会话启动失败"
  exit 1
fi

# 把会话环境注入当前 shell：后续脚本共用同一套端口/地址/网络。
eval "$(deno run -A scripts/e2e/session.ts env --session "$SESSION")"
export E2E_SESSION="$SESSION"

echo ""
echo ">>> [2/3] 运行所有测试..."

PASS=0
FAIL=0
REPORT=""

run_test() {
  local name="$1"
  shift
  echo "=========================================="
  echo " 套件: $name"
  echo "=========================================="
  set +e
  "$@"
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

run_test "noj-core E2E" bash "$ROOT_DIR/scripts/e2e/core.sh" --session "$SESSION"
run_test "noj-judge E2E" bash "$ROOT_DIR/scripts/e2e/judge.sh"

# ── Step 3: 环境停止（trap 统一处理） ──
echo ">>> [3/3] 停止 E2E 环境..."

echo "=========================================="
echo " E2E 测试报告"
echo "=========================================="
echo ""
printf "%b" "$REPORT"
echo ""
echo "总计: $((PASS + FAIL))  |  通过: $PASS  |  失败: $FAIL"
echo "=========================================="

exit $([ "$FAIL" -gt 0 ] && echo 1 || echo 0)
