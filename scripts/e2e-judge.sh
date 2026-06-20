#!/usr/bin/env bash
# ============================================================================
# noj-judge E2E 测试运行脚本
#
# 测试 noj-judge 的 Docker 沙箱评测能力：
#   - 基础评测流程（代码注入 → 执行 → 结果）
#   - 资源限制（CPU / 内存 / 超时）
#   - 安全隔离（不可信代码沙箱）
#   - 支持包加载
#
# 用法：
#   bash scripts/e2e-judge.sh
#
# 依赖：
#   - 运行中的 Redis（REDIS_URL）
#   - Docker daemon（/var/run/docker.sock）
#   - Rust 工具链（cargo）
#
# 环境变量（可覆盖）：
#   REDIS_URL    - Redis 连接（默认 redis://localhost:6379）
# ============================================================================

set -uo pipefail

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()   { echo -e "\n${BOLD}── ${BLUE}$1${NC} ──${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
info()   { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${BOLD}${CYAN}$1${NC}\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ── 进入项目目录 ──
cd "$(dirname "$0")/../noj-judge"

# ── 配置 ──
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export REDIS_URL

cleanup() {
  echo ""
  info "清理..."
}
trap cleanup EXIT

# ========== 1. 前置检查 ==========
header "NOJ JUDGE E2E 测试套件"
info "Redis: $REDIS_URL"

step "1/3  前置检查"
if ! command -v cargo &>/dev/null; then
  fail "未找到 cargo，请安装 Rust 工具链"
  exit 1
fi

if ! docker info &>/dev/null; then
  fail "Docker daemon 未运行"
  exit 1
fi
ok "Docker daemon 就绪"

if ! redis-cli -u "$REDIS_URL" ping &>/dev/null; then
  warn "Redis 未就绪，尝试启动..."
  docker start noj-redis 2>/dev/null || {
    fail "Redis 不可用，请先启动: docker compose up -d redis"
    exit 1
  }
fi
ok "Redis 就绪"

# ========== 2. 编译（带测试特性） ==========
step "2/3  编译 noj-judge（测试模式）"
if cargo build --test e2e 2>&1; then
  ok "编译完成"
else
  fail "编译失败"
  exit 1
fi

# ========== 3. 运行 E2E 测试 ==========
step "3/3  执行 E2E 测试"
echo ""
NOJ_RUN_E2E=1 \
cargo test --test e2e -- --ignored --test-threads=1 2>&1

TEST_EXIT=$?
echo ""
if [ $TEST_EXIT -eq 0 ]; then
  header "✅  全部 noj-judge E2E 测试通过"
else
  header "⚠️  部分 noj-judge E2E 测试未通过"
  warn "检查上方 FAILED 输出定位问题"
fi

echo ""
info "日志: $(pwd)/target/debug/test_output/"
echo ""
