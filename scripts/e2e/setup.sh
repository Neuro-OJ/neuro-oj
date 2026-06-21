#!/usr/bin/env bash
#
# E2E 环境启动脚本
# 自动启动所有 E2E 测试依赖：Docker 容器 → 数据库 → core → judge
#
# 使用方法: source scripts/e2e/setup.sh   # 加载 E2E_* 环境变量
#      或   bash scripts/e2e/setup.sh      # 仅启动（不导出变量）
#
# 停止:     bash scripts/e2e/teardown.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# ── E2E 配置 ──────────────────────────────────
E2E_DB_URL="${E2E_DB_URL:-postgres://e2e:e2e@localhost:5433/e2e}"
E2E_REDIS_URL="${E2E_REDIS_URL:-redis://localhost:6380/1}"
E2E_CORE_PORT="${E2E_CORE_PORT:-8099}"
E2E_CORE_URL="http://localhost:$E2E_CORE_PORT"
E2E_UI_URL="${E2E_UI_URL:-http://localhost:3000}"
E2E_JUDGE_BIN="${E2E_JUDGE_BIN:-$ROOT_DIR/noj-judge/target/release/noj-judge}"
E2E_JWT_SECRET="${E2E_JWT_SECRET:-e2e-test-secret}"

# 导出供子脚本使用
export E2E_DB_URL E2E_REDIS_URL E2E_CORE_PORT E2E_CORE_URL E2E_UI_URL
export JWT_SECRET="$E2E_JWT_SECRET"

# ── 颜色 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
step() { echo -e "\n${BOLD}── ${CYAN}$1${NC} ──${NC}"; }

echo ""
echo -e "${BOLD}=========================================="
echo " Neuro OJ — E2E 环境启动"
echo -e "==========================================${NC}"
echo ""

# ══════════════════════════════════════════════
# 1. Docker 基础设施
# ══════════════════════════════════════════════
step "1/6  Docker 基础设施"

if ! docker info --format '{{.ServerVersion}}' > /dev/null 2>&1; then
  fail "Docker 未运行，请先启动 Docker"
  exit 1
fi
ok "Docker 运行中"

# 启动 E2E 专用容器（PostgreSQL :5433, Redis :6380）
if docker ps --format '{{.Names}}' | grep -q '^noj-e2e-postgres$'; then
  ok "noj-e2e-postgres 已在运行"
else
  info "启动 noj-e2e-postgres..."
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" up -d postgres
  ok "noj-e2e-postgres 已启动"
fi

if docker ps --format '{{.Names}}' | grep -q '^noj-e2e-redis$'; then
  ok "noj-e2e-redis 已在运行"
else
  info "启动 noj-e2e-redis..."
  docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" up -d redis
  ok "noj-e2e-redis 已启动"
fi

# 等待数据库就绪
info "等待 PostgreSQL 就绪..."
for i in $(seq 1 30); do
  if docker exec noj-e2e-postgres pg_isready -U e2e > /dev/null 2>&1; then
    ok "PostgreSQL 就绪"
    break
  fi
  sleep 1
done

info "等待 Redis 就绪..."
for i in $(seq 1 15); do
  if docker exec noj-e2e-redis redis-cli ping > /dev/null 2>&1; then
    ok "Redis 就绪"
    break
  fi
  sleep 1
done

# ══════════════════════════════════════════════
# 2. 数据库迁移 + 种子
# ══════════════════════════════════════════════
step "2/6  noj-core 依赖安装 + 数据库迁移 + 种子"

cd "$ROOT_DIR/noj-core"

info "安装 npm 依赖..."
deno install 2>&1 | grep -v deprecat | head -5 || true
ok "依赖就绪"

DATABASE_URL="$E2E_DB_URL" REDIS_URL="$E2E_REDIS_URL" \
  deno task migrate 2>&1 | grep -vE 'severity|code:|file:|line:|routine:|^}$|^\{$' || true
ok "迁移完成"

DATABASE_URL="$E2E_DB_URL" ADMIN_EMAIL="e2e_admin@test.com" ADMIN_PASS="e2e_admin_pass" \
  deno run --allow-net --allow-env --allow-read --allow-write scripts/seed.ts 2>&1 | grep -vE 'severity|code:|file:|line:|routine:|^}$|^\{$' || true
ok "种子数据就绪"

# ══════════════════════════════════════════════
# 3. Docker 评测镜像
# ══════════════════════════════════════════════
step "3/6  Docker 评测镜像"

if docker images --format '{{.Repository}}' | grep -q '^noj-judge-python$'; then
  ok "noj-judge-python 镜像已存在"
else
  info "构建 noj-judge-python 镜像..."
  docker build -t noj-judge-python \
    -f "$ROOT_DIR/noj-judge/docker/python/Dockerfile" \
    "$ROOT_DIR/noj-judge" 2>&1 | tail -3
  ok "noj-judge-python 镜像已构建"
fi

# ══════════════════════════════════════════════
# 4. noj-core 服务
# ══════════════════════════════════════════════
step "4/6  noj-core (:$E2E_CORE_PORT)"

if curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
  ok "noj-core 已在运行 (:$E2E_CORE_PORT)"
  E2E_CORE_PID=""
else
  cd "$ROOT_DIR/noj-core"
  DATABASE_URL="$E2E_DB_URL" REDIS_URL="$E2E_REDIS_URL" PORT="$E2E_CORE_PORT" JWT_SECRET="$E2E_JWT_SECRET" \
    deno run --allow-net --allow-env --allow-read src/main.ts \
    > /tmp/noj-e2e-core.log 2>&1 &
  E2E_CORE_PID=$!
  echo "$E2E_CORE_PID" > /tmp/noj-e2e-core.pid

  info "等待 noj-core 就绪..."
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
      ok "noj-core 就绪 (PID $E2E_CORE_PID, :$E2E_CORE_PORT)"
      break
    fi
    sleep 1
  done

  if ! curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
    fail "noj-core 启动超时"
    tail -30 /tmp/noj-e2e-core.log
    exit 1
  fi
fi

# ══════════════════════════════════════════════
# 5. noj-judge
# ══════════════════════════════════════════════
step "5/6  noj-judge"

if pgrep -f "target/debug/noj-judge" > /dev/null 2>&1; then
  ok "noj-judge 已在运行"
  E2E_JUDGE_PID=""
else
  info "编译 noj-judge..."
  cd "$ROOT_DIR/noj-judge"
  cargo build --release 2>&1 | tail -3

  info "启动 noj-judge..."
  REDIS_URL="$E2E_REDIS_URL" nohup "$E2E_JUDGE_BIN" \
    > /tmp/noj-e2e-judge.log 2>&1 &
  E2E_JUDGE_PID=$!
  echo "$E2E_JUDGE_PID" > /tmp/noj-e2e-judge.pid
  sleep 2

  if pgrep -f "target/release/noj-judge" > /dev/null 2>&1; then
    ok "noj-judge 已启动 (PID $E2E_JUDGE_PID)"
  else
    fail "noj-judge 启动失败"
    tail -10 /tmp/noj-e2e-judge.log
    exit 1
  fi
fi

# ══════════════════════════════════════════════
# 6. noj-ui 前端
# ══════════════════════════════════════════════
step "6/6  noj-ui"

if curl -sf "$E2E_UI_URL" > /dev/null 2>&1; then
  ok "noj-ui 已在运行 ($E2E_UI_URL)"
else
  info "自动启动 noj-ui（API 代理 → E2E core :$E2E_CORE_PORT）..."
  cd "$ROOT_DIR/noj-ui"
  NUXT_API_BASE="$E2E_CORE_URL" npm run dev &>/tmp/noj-e2e-ui.log &
  E2E_UI_PID=$!
  echo "$E2E_UI_PID" > /tmp/noj-e2e-ui.pid

  info "等待 noj-ui 就绪..."
  for i in $(seq 1 60); do
    if curl -sf "$E2E_UI_URL" > /dev/null 2>&1; then
      ok "noj-ui 就绪 (PID $E2E_UI_PID, $E2E_UI_URL)"
      break
    fi
    sleep 1
  done

  if ! curl -sf "$E2E_UI_URL" > /dev/null 2>&1; then
    fail "noj-ui 启动超时"
    tail -20 /tmp/noj-e2e-ui.log
    echo ""
    echo "  请手动启动：cd noj-ui && npm run dev"
  fi
fi

# ══════════════════════════════════════════════
# 汇总
# ══════════════════════════════════════════════
echo ""
echo -e "${BOLD}=========================================="
echo " E2E 环境就绪"
echo -e "==========================================${NC}"
echo ""
echo "  ${CYAN}PostgreSQL${NC}    $E2E_DB_URL"
echo "  ${CYAN}Redis${NC}         $E2E_REDIS_URL"
echo "  ${CYAN}noj-core${NC}      $E2E_CORE_URL"
echo "  ${CYAN}noj-ui${NC}        $E2E_UI_URL"
echo "  ${CYAN}noj-judge${NC}     PID $(cat /tmp/noj-e2e-judge.pid 2>/dev/null || echo 'N/A')"
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
E2E_UI_URL="$E2E_UI_URL"
E2E_JWT_SECRET="$E2E_JWT_SECRET"
JWT_SECRET="$E2E_JWT_SECRET"
EOF
