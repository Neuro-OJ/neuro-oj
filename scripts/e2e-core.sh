#!/usr/bin/env bash
# ============================================================================
# E2E 测试运行脚本
#
# 用法：
#   bash scripts/e2e.sh
#
# 依赖：
#   - 运行中的 PostgreSQL（DATABASE_URL）
#   - 运行中的 Redis（REDIS_URL）
#   - Deno
#
# 环境变量（可覆盖）：
#   DATABASE_URL  - PostgreSQL 连接（默认 postgres://e2e:e2e@localhost:5432/e2e）
#   REDIS_URL     - Redis 连接（默认 redis://localhost:6379）
#   JWT_SECRET    - JWT 签名密钥（默认 e2e-test-secret）
#   PORT          - 服务器端口（默认 8099）
# ============================================================================

set -uo pipefail

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

step()   { echo -e "\n${BOLD}── ${BLUE}$1${NC} ──${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
info()   { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${BOLD}${CYAN}$1${NC}\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ── 进入项目目录 ──
cd "$(dirname "$0")/../noj-core"

# ── 配置 ──
DATABASE_URL="${DATABASE_URL:-postgres://e2e:e2e@localhost:5432/e2e}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
JWT_SECRET="${JWT_SECRET:-e2e-test-secret}"
PORT="${PORT:-8099}"
ADMIN_EMAIL="${ADMIN_EMAIL:-e2e_admin@test.com}"
ADMIN_PASS="${ADMIN_PASS:-e2e_admin_pass}"
export DATABASE_URL REDIS_URL JWT_SECRET PORT ADMIN_EMAIL ADMIN_PASS

cleanup() {
  echo ""
  if [ -n "${SERVER_PID:-}" ]; then
    info "正在停止服务器 (PID $SERVER_PID) ..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    ok "服务器已停止"
  fi
}
trap cleanup EXIT

# ========== 1. 数据库迁移 ==========
header "NOJ E2E 测试套件"
info "数据库: $DATABASE_URL"
info "Redis:   $REDIS_URL"
info "端口:    $PORT"
info "管理员:  $ADMIN_EMAIL"

step "1/4  数据库迁移"
MIGRATE_OUTPUT=$(deno task migrate 2>&1 || true)
echo "$MIGRATE_OUTPUT" | grep -vE 'severity_local:|severity:|code:|file:|line:|routine:|^}$|^\{$' || true
echo ""
ok "迁移完成"

# ========== 2. 种子数据 ==========
step "2/4  种子数据（题目 + 分类 + 管理员）"
echo "  [seed] 开始写入..."
if deno run --allow-net --allow-env --allow-read --allow-write scripts/seed.ts 2>&1; then
  ok "种子数据就绪"
else
  fail "种子数据失败"
  exit 1
fi

# ========== 3. 启动服务器 ==========
step "3/4  启动 noj-core 服务器"
deno run --allow-net --allow-env --allow-read src/main.ts > /tmp/noj-e2e-server.log 2>&1 &
SERVER_PID=$!
ok "服务器进程 PID: $SERVER_PID"

info "等待服务器就绪 ..."
SPINNER=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo -e "\r  ${GREEN}✓${NC} 服务器就绪 (${i}x0.5s)"
    break
  fi
  idx=$(( (i - 1) % ${#SPINNER[@]} ))
  echo -ne "\r  ${SPINNER[$idx]} 等待 ${i}s ..."
  sleep 0.5
done

# 确认真的就绪了
if ! curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
  fail "服务器启动超时 (60 次重试)，日志如下："
  tail -20 /tmp/noj-e2e-server.log
  exit 1
fi

# ========== 4. 运行 E2E 测试 ==========
step "4/4  执行 E2E 测试"

echo ""
NOJ_RUN_E2E=1 \
E2E_BASE_URL="http://localhost:$PORT" \
E2E_ADMIN_EMAIL="$ADMIN_EMAIL" \
E2E_ADMIN_PASS="$ADMIN_PASS" \
deno test -A tests/e2e/api.test.ts 2>&1

# 判断测试结果
TEST_EXIT=$?
echo ""
if [ $TEST_EXIT -eq 0 ]; then
  header "✅  全部 E2E 测试通过"
else
  header "⚠️  部分 E2E 测试未通过"
  warn "检查上方 FAILED 输出定位问题"
fi

# ── 汇总 ──
echo ""
echo -e "  ${BLUE}服务${NC}     http://localhost:$PORT"
echo -e "  ${BLUE}健康检查${NC}  http://localhost:$PORT/health"
echo -e "  ${BLUE}管理员${NC}    $ADMIN_EMAIL / $ADMIN_PASS"
echo -e "  ${BLUE}服务器日志${NC} /tmp/noj-e2e-server.log"
echo ""
echo -e "  按 ${BOLD}Ctrl+C${NC} 停止服务器并退出"
echo ""

wait "$SERVER_PID"
