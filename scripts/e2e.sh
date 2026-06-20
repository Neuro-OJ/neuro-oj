#!/usr/bin/env bash
# =============================================================================
# noj-judge E2E 全链路测试运行脚本
#
# 自动管理依赖服务（Redis + PostgreSQL），运行集成测试，清理环境。
#
# 前置条件：
#   - Docker 和 docker compose 已安装
#   - Rust 工具链可用（cargo test）
#   - 当前用户有 /var/run/docker.sock 权限
#
# 使用方式：
#   ./scripts/e2e.sh              # 运行全链路测试
#   ./scripts/e2e.sh --skip-build # 跳过镜像构建（加速重复运行）
#   ./scripts/e2e.sh --only-judge # 仅运行 noj-judge 集成测试（不需要 DB）
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
PASS="${GREEN}✓${NC}"
FAIL="${RED}✗${NC}"
INFO="${BLUE}→${NC}"
WARN="${YELLOW}⚠${NC}"

# ── 参数解析 ──
SKIP_BUILD=false
ONLY_JUDGE=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --only-judge) ONLY_JUDGE=true ;;
    --help)
      echo "用法: $0 [--skip-build] [--only-judge] [--help]"
      exit 0
      ;;
  esac
done

# ── 清理函数 ──
cleanup() {
  local EXIT_CODE=$?
  echo ""
  echo -e "${INFO} 清理测试环境..."
  if [ "$ONLY_JUDGE" = false ]; then
    # 回到项目根目录执行 docker compose down
    cd "$REPO_DIR" 2>/dev/null || true
    echo -e "${INFO} 停止并移除 docker-compose 容器..."
    docker compose -f docker-compose.e2e.yml down --remove-orphans --volumes --timeout 10
    echo -e "${PASS} docker-compose 容器已清理"
  fi
  echo -e "${PASS} 清理完成"
  exit "$EXIT_CODE"
}
trap cleanup EXIT INT TERM

# ── 环境检查 ──
echo -e "${INFO} Neuro OJ E2E 测试"
echo ""

# 先确保没有残留容器
if [ "$ONLY_JUDGE" = false ]; then
  echo -e "${INFO} 确保测试环境干净..."
  cd "$REPO_DIR"
  docker compose -f docker-compose.e2e.yml down --remove-orphans --volumes --timeout 5 2>/dev/null || true
  echo -e "${PASS} 环境干净"
fi

if ! docker info &>/dev/null; then
  echo -e "${FAIL} Docker daemon 未运行"
  exit 1
fi
echo -e "${PASS} Docker daemon 运行中"

# ── 第 1 步：构建测试镜像 ──
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${INFO} 构建测试 Docker 镜像..."
  cd "$REPO_DIR/noj-judge/tests/e2e"
  docker build \
    -t noj-judge-test-runner \
    -f Dockerfile.test-runner \
    --quiet \
    .
  echo -e "${PASS} 测试镜像构建完成: noj-judge-test-runner"
else
  echo -e "${WARN} 跳过镜像构建（--skip-build）"
fi

# ── 第 2 步：启动依赖服务 ──
if [ "$ONLY_JUDGE" = false ]; then
  echo -e "${INFO} 启动 Redis + PostgreSQL..."
  cd "$REPO_DIR"
  docker compose -f docker-compose.e2e.yml up -d redis postgres
  echo -e "${INFO} 等待服务就绪..."

  # 等待 PostgreSQL
  for i in $(seq 1 30); do
    if docker compose -f docker-compose.e2e.yml exec -T postgres pg_isready -U e2e &>/dev/null; then
      echo -e "${PASS} PostgreSQL 就绪"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo -e "${FAIL} PostgreSQL 启动超时"
      exit 1
    fi
    sleep 1
  done

  # 等待 Redis
  for i in $(seq 1 15); do
    if docker compose -f docker-compose.e2e.yml exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
      echo -e "${PASS} Redis 就绪"
      break
    fi
    if [ "$i" -eq 15 ]; then
      echo -e "${FAIL} Redis 启动超时"
      exit 1
    fi
    sleep 1
  done
else
  echo -e "${WARN} 跳过依赖服务（--only-judge）"
fi

echo ""

# ── 第 3 步：运行 noj-judge 集成测试 ──
echo -e "${INFO} 运行 noj-judge 集成测试..."
echo -e "      ${YELLOW}测试文件：${NC}"
echo -e "      ${BLUE}  e2e_docker_basic.rs${NC}      — 容器生命周期"
echo -e "      ${BLUE}  e2e_resource_limits.rs${NC}    — 超时 / OOM / 内存限制"
echo -e "      ${BLUE}  e2e_security_isolation.rs${NC} — 网络隔离 / 敏感路径"
echo -e "      ${BLUE}  e2e_support_package.rs${NC}    — 评测流程 / ---RESULT---"
echo ""

cd "$REPO_DIR/noj-judge"
export NOJ_RUN_E2E=1

# 逐个运行各测试目标（Cargo 按文件名 --test 命名）
E2E_TESTS=(
  e2e_docker_basic
  e2e_resource_limits
  e2e_security_isolation
  e2e_support_package
)
ALL_PASSED=true

for test_target in "${E2E_TESTS[@]}"; do
  echo -e "${INFO} 运行 ${BLUE}${test_target}${NC}..."
  if cargo test --test "$test_target" -- --ignored 2>&1 | tail -1 | grep -q "FAILED"; then
    echo -e "${FAIL} ${test_target} 失败"
    ALL_PASSED=false
    break
  fi
done

if [ "$ALL_PASSED" = true ]; then
  echo ""
  echo -e "${PASS} noj-judge 集成测试全部通过"
else
  echo ""
  echo -e "${FAIL} noj-judge 集成测试有失败"
  exit 1
fi

# ── 第 4 步：（可选）运行 noj-core 测试 ──
if [ "$ONLY_JUDGE" = false ]; then
  echo ""
  echo -e "${INFO} 运行 noj-core 集成测试..."
  cd "$REPO_DIR/noj-core"
  export DATABASE_URL="postgres://e2e:e2e@localhost:5432/e2e_test"
  export REDIS_URL="redis://localhost:6379"
  export JWT_SECRET="e2e-test-secret"
  export NOJ_RUN_E2E=1

  if deno test -A --env-file 2>&1; then
    echo ""
    echo -e "${PASS} noj-core 测试全部通过"
  else
    echo ""
    echo -e "${FAIL} noj-core 测试有失败"
    exit 1
  fi
fi

# ── 完成 ──
echo ""
echo -e "${PASS} ${GREEN}全链路 E2E 测试通过！${NC}"
echo -e "${INFO} 环境已自动清理"
