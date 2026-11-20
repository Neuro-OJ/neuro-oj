#!/usr/bin/env bash
# ============================================================================
# noj-core E2E 测试（P6-B：会话私有）
#
# 依赖：已启动的 E2E 会话（deno run -A scripts/e2e/session.ts up --session <name>）
#
# 用法：
#   bash scripts/e2e/core.sh --session <name>
#   bash scripts/e2e/core.sh                 # 使用当前环境变量（CI/已 eval 会话 env）
#
# 环境来源优先级：显式环境变量 > 会话私有 .env（noj-tests/test-results/e2e-sessions）
# 不再读取全局 /tmp/noj-e2e-env.sh。
# ============================================================================

source "$(dirname "$0")/lib.sh"
set -uo pipefail

SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session)
      SESSION="${2:-}"
      shift 2
      ;;
    *)
      fail "未知参数: $1"
      exit 2
      ;;
  esac
done

if [ -n "$SESSION" ]; then
  ENV_FILE="$ROOT_DIR/noj-tests/test-results/e2e-sessions/$SESSION.env"
  if [ ! -f "$ENV_FILE" ]; then
    fail "找不到会话环境文件：$ENV_FILE（先用 session.ts up 启动）"
    exit 2
  fi
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
  ok "已加载会话环境：$SESSION"
fi

E2E_CORE_URL="${E2E_CORE_URL:-http://localhost:${E2E_CORE_PORT:-8099}}"

echo ""
echo -e "${BOLD}━━━ noj-core E2E ━━━${NC}"
info "noj-core: $E2E_CORE_URL"

if ! curl -sf "$E2E_CORE_URL/health" > /dev/null 2>&1; then
  fail "noj-core 未在运行，请先执行 deno run -A scripts/e2e/session.ts up --session <name>"
  exit 1
fi

cd "$ROOT_DIR/noj-tests"

echo ""
echo -e "  ${CYAN}▶ noj-tests E2E (API + 管道 + 队列)${NC}"
NOJ_RUN_E2E=1 \
E2E_BASE_URL="$E2E_CORE_URL" \
E2E_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-e2e_admin@test.com}" \
E2E_ADMIN_PASS="${E2E_ADMIN_PASS:-e2e_admin_pass}" \
deno test -A e2e/ 2>&1

TEST_EXIT=$?

if [ $TEST_EXIT -eq 0 ]; then
  echo ""
  echo -e "  ${GREEN}✓ noj-tests E2E: 通过${NC}"
  echo ""
  echo -e "${BOLD}✅  E2E 全部通过${NC}"
else
  echo ""
  echo -e "${BOLD}❌  E2E 部分失败${NC}"
fi

exit $TEST_EXIT
