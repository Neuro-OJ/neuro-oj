#!/usr/bin/env bash
#
# E2E 环境启动脚本
# 使用 Docker Compose 一键启动完整评测栈
#
# 使用方法: source scripts/e2e/setup.sh   # 加载 E2E_* 环境变量
#      或   bash scripts/e2e/setup.sh      # 仅启动（不导出变量）
#
# 停止:     bash scripts/e2e/teardown.sh

source "$(dirname "$0")/lib.sh"

# ── E2E 配置 ──────────────────────────────────
E2E_DB_URL="${E2E_DB_URL:-postgres://e2e:e2e@localhost:5433/e2e}"
E2E_REDIS_URL="${E2E_REDIS_URL:-redis://localhost:6380/1}"
E2E_CORE_PORT="${E2E_CORE_PORT:-8099}"
E2E_CORE_URL="http://localhost:$E2E_CORE_PORT"
E2E_JWT_SECRET="${E2E_JWT_SECRET:-e2e-test-secret}"

# 导出供子脚本使用
export E2E_DB_URL E2E_REDIS_URL E2E_CORE_PORT E2E_CORE_URL
export JWT_SECRET="$E2E_JWT_SECRET"

echo ""
echo -e "${BOLD}=========================================="
echo " Neuro OJ — E2E 环境启动"
echo -e "==========================================${NC}"

# ══════════════════════════════════════════════
# 1. 启动 Docker Compose 评测栈
# ══════════════════════════════════════════════
step "1/2  Docker Compose 评测栈"

if [ -z "${CI:-}" ]; then
  if ! docker info --format '{{.ServerVersion}}' > /dev/null 2>&1; then
    fail "Docker 未运行，请先启动 Docker"
    exit 1
  fi
  ok "Docker 运行中"

  info "构建并启动服务..."
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" up -d --build
  ok "评测栈已启动"
else
  ok "CI 环境检测，跳过 Docker Compose（使用 GitHub Actions 服务容器）"
fi

# ══════════════════════════════════════════════
# 2. 等待 noj-core 就绪
# ══════════════════════════════════════════════
step "2/2  等待 noj-core 就绪"

info "等待 noj-core API (:$E2E_CORE_PORT)..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
    ok "noj-core 就绪 (:$E2E_CORE_PORT)"
    break
  fi
  sleep 2
done

if ! curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
  fail "noj-core 启动超时"
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" logs --tail=50 noj-core
  exit 1
fi

# ══════════════════════════════════════════════
# 3. 初始化 MinIO bucket
# ══════════════════════════════════════════════
step "3/3  初始化 MinIO"

if [ -z "${CI:-}" ]; then
  info "初始化 MinIO bucket..."
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" up -d minio minio-init
  ok "MinIO bucket 已初始化"
else
  ok "CI 环境检测，跳过 MinIO 初始化"
fi

# ── 汇总 ──
echo ""
echo -e "${BOLD}=========================================="
echo " E2E 环境就绪"
echo -e "==========================================${NC}"
echo ""
echo "  ${CYAN}PostgreSQL${NC}    $E2E_DB_URL"
echo "  ${CYAN}Redis${NC}         $E2E_REDIS_URL"
echo "  ${CYAN}noj-core${NC}      $E2E_CORE_URL"
echo "  ${CYAN}MinIO${NC}         http://localhost:9002"
echo ""
echo "  stop:    bash scripts/e2e/teardown.sh"
echo "  test:    bash scripts/e2e/run-all.sh"
echo ""

# 保存环境变量供其他脚本 source
cat > /tmp/noj-e2e-env.sh << EOF
E2E_DB_URL="$E2E_DB_URL"
E2E_REDIS_URL="$E2E_REDIS_URL"
E2E_CORE_URL="$E2E_CORE_URL"
E2E_CORE_PORT="$E2E_CORE_PORT"
E2E_JWT_SECRET="$E2E_JWT_SECRET"
JWT_SECRET="$E2E_JWT_SECRET"
EOF
