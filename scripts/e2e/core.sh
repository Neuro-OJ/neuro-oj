#!/usr/bin/env bash
# ============================================================================
# noj-core E2E 测试
#
# 依赖：已运行的 E2E 环境（由 setup.sh 启动）
#   - PostgreSQL / Redis 容器
#   - noj-core 在 :8099 运行
#   - 数据库已 migrate + seed
#
# 环境变量（覆盖默认，若未设置则读取 /tmp/noj-e2e-env.sh）：
#   E2E_CORE_URL  - noj-core 地址（默认 http://localhost:8099）
#   E2E_CORE_PORT - 端口（默认 8099）
# ============================================================================

source "$(dirname "$0")/lib.sh"
set -uo pipefail

# 加载 E2E 环境（如果 setup.sh 有写入的话）
[ -f /tmp/noj-e2e-env.sh ] && source /tmp/noj-e2e-env.sh

E2E_CORE_URL="${E2E_CORE_URL:-http://localhost:8099}"
E2E_CORE_PORT="${E2E_CORE_PORT:-8099}"

echo ""
echo -e "${BOLD}━━━ noj-core E2E ━━━${NC}"
info "noj-core: $E2E_CORE_URL"

# 确保 core 在运行
if ! curl -sf "$E2E_CORE_URL/health" > /dev/null 2>&1; then
  fail "noj-core 未在运行，请先执行 bash scripts/e2e/setup.sh"
  exit 1
fi

# 运行 noj-tests E2E 测试（全部迁移到 noj-tests 包）
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
fi

if [ $TEST_EXIT -eq 0 ]; then
  echo ""
  echo -e "${BOLD}✅  E2E 全部通过${NC}"
else
  echo ""
  echo -e "${BOLD}❌  E2E 部分失败${NC}"
fi

exit $TEST_EXIT
