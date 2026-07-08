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

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# 加载 E2E 环境（如果 setup.sh 有写入的话）
[ -f /tmp/noj-e2e-env.sh ] && source /tmp/noj-e2e-env.sh

# ── 进入项目目录 ──
cd "$ROOT_DIR/noj-judge"

# ── 配置（用独立 Redis DB 1，不污染开发环境 DB 0）──
REDIS_URL="${REDIS_URL:-redis://localhost:6380/1}"
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

# redis-cli -u 不支持端口+DB 索引的 URI 格式，拆开连接
REDIS_HOST="localhost"
REDIS_PORT="${REDIS_URL##*:}"
REDIS_PORT="${REDIS_PORT%%/*}"
if ! redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping &>/dev/null; then
  warn "Redis 未就绪，尝试启动..."
  docker start noj-e2e-redis 2>/dev/null || {
    fail "Redis 不可用，请先执行: bash scripts/e2e/setup.sh"
    exit 1
  }
fi
ok "Redis 就绪"

# ========== 2. 编译（所有 E2E 测试目标） ==========
E2E_TARGETS=(
  e2e_docker_basic
  e2e_resource_limits
  e2e_security_isolation
  e2e_support_package
  e2e_problem_limits
  e2e_container_pool
)

step "2/3  编译 noj-judge（${#E2E_TARGETS[@]} 个 E2E 目标）"
for target in "${E2E_TARGETS[@]}"; do
  echo "  building $target ..."
  if ! cargo build --test "$target" 2>&1; then
    fail "编译 $target 失败"
    exit 1
  fi
done
ok "全部编译完成"

# ========== 3. 运行 E2E 测试 ==========
step "3/3  执行 E2E 测试"
PASS=0
FAIL=0
for target in "${E2E_TARGETS[@]}"; do
  echo ""
  echo "  ── $target ──"
  if NOJ_RUN_E2E=1 cargo test --test "$target" -- --ignored --test-threads=1 2>&1; then
    echo -e "  ${GREEN}✓${NC} $target 通过"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $target 失败"
    ((FAIL++))
  fi
done

echo ""
if [ $FAIL -eq 0 ]; then
  header "✅  全部 noj-judge E2E 测试通过（${PASS}/${#E2E_TARGETS[@]}）"
else
  header "⚠️  noj-judge E2E 测试 ${PASS} 通过，${FAIL} 失败"
fi

echo ""
info "日志: $(pwd)/target/debug/test_output/"
echo ""
