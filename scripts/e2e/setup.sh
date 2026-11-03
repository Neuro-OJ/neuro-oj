#!/usr/bin/env bash
#
# E2E 环境启动脚本（P6-B：会话私有）
#
# 只能由 `deno run -A scripts/e2e/session.ts up --session <name>` 调用：
# - 端口、项目名、网络名、DB 名全部由会话清单注入；
# - 不再写全局 /tmp/noj-e2e-env.sh —— 清单与 session 私有 .env 是唯一事实源；
# - 构建产物复用结论由 session.ts 判定后通过 E2E_*_ARTIFACT_REUSE 传入。
#
# 用法: bash scripts/e2e/setup.sh [--fresh]
#   --fresh  先清卷重建容器，并强制重建构建产物（不复用缓存）

source "$(dirname "$0")/lib.sh"

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    *)
      fail "未知参数: $arg"
      exit 2
      ;;
  esac
done

# ── 会话上下文（由 session.ts 注入，缺失即失败）───────────────
: "${NOJ_E2E_SESSION:?缺少 NOJ_E2E_SESSION：请用 deno run -A scripts/e2e/session.ts up --session <name>}"
: "${COMPOSE_PROJECT_NAME:?缺少 COMPOSE_PROJECT_NAME：应在会话清单中}"
: "${E2E_CORE_PORT:?缺少 E2E_CORE_PORT：应在会话清单中}"

E2E_CORE_URL="${E2E_CORE_URL:-http://localhost:$E2E_CORE_PORT}"
E2E_JUDGE_RESOURCE_POOLS="${E2E_JUDGE_RESOURCE_POOLS:-ai}"
E2E_PACKAGES_ARTIFACT_REUSE="${E2E_PACKAGES_ARTIFACT_REUSE:-0}"
E2E_UI_ARTIFACT_REUSE="${E2E_UI_ARTIFACT_REUSE:-0}"
E2E_BUILD_UI="${E2E_BUILD_UI:-0}"
E2E_SDK_REUSE="${E2E_SDK_REUSE:-0}"
E2E_EVALUATOR_NETWORK="${E2E_EVALUATOR_NETWORK:-noj-eval-net}"
SDK_IMAGE_BUILDER="${NOJ_E2E_SDK_IMAGE_BUILDER:-$ROOT_DIR/noj-judge/scripts/build-sdk-images.sh}"
COMPOSE=(docker compose -f "$ROOT_DIR/docker-compose.e2e.yml" -p "$COMPOSE_PROJECT_NAME")

echo ""
echo -e "${BOLD}=========================================="
echo " Neuro OJ — E2E 环境启动（session: $NOJ_E2E_SESSION）"
echo -e "==========================================${NC}"
echo "  project : $COMPOSE_PROJECT_NAME"
echo "  network : $E2E_EVALUATOR_NETWORK"
echo "  core    : :$E2E_CORE_PORT"
echo ""

# ══════════════════════════════════════════════
# 1. 前置检查
# ══════════════════════════════════════════════
step "1/4  前置检查"

if ! docker info --format '{{.ServerVersion}}' > /dev/null 2>&1; then
  fail "Docker 未运行，请先启动 Docker"
  exit 1
fi
ok "Docker 运行中"

# ══════════════════════════════════════════════
# 2. 构建产物（SDK 镜像 / 题目支持包 / UI）
# ══════════════════════════════════════════════
step "2/4  构建产物（命中缓存的跳过）"

if [ "$E2E_SDK_REUSE" = "1" ]; then
  ok "SDK 镜像：复用上次构建（BuildKit 缓存仍生效）"
else
  info "刷新本地 SDK 镜像..."
  if ! "$SDK_IMAGE_BUILDER"; then
    fail "SDK 镜像构建失败，停止 E2E 启动"
    exit 1
  fi
  ok "SDK 镜像已从当前工作树构建"
fi

if [[ ",$E2E_JUDGE_RESOURCE_POOLS," == *,oi-native,* ]]; then
  if ! docker image inspect noj-oi-cpp:latest > /dev/null 2>&1; then
    fail "OI Native 已启用但 noj-oi-cpp 镜像未构建，停止 E2E 启动"
    exit 1
  fi
  ok "OI Native C++ 运行时就绪"
fi

if [ "$E2E_PACKAGES_ARTIFACT_REUSE" = "1" ] && [ "$FRESH" != "1" ]; then
  ok "题目支持包：复用已构建产物（输入未变化）"
else
  info "构建题目支持包 (data/packages)..."
  if ! (cd "$ROOT_DIR/noj-core" && deno task problems:build > /tmp/"$NOJ_E2E_SESSION".packages.log 2>&1); then
    fail "题目支持包构建失败：/tmp/$NOJ_E2E_SESSION.packages.log"
    exit 1
  fi
  ok "题目支持包已构建"
fi

if [ "$E2E_BUILD_UI" = "1" ]; then
  if [ "$E2E_UI_ARTIFACT_REUSE" = "1" ] && [ "$FRESH" != "1" ]; then
    ok "UI 构建：复用已构建产物（输入未变化）"
  else
    info "构建 noj-ui（Nuxt build）..."
    if ! (cd "$ROOT_DIR/noj-ui" && deno task build > /tmp/"$NOJ_E2E_SESSION".ui.log 2>&1); then
      fail "UI 构建失败：/tmp/$NOJ_E2E_SESSION.ui.log"
      exit 1
    fi
    ok "UI 构建完成"
  fi
else
  info "跳过 UI 构建（E2E_BUILD_UI=0；浏览器用例需要 --ui 或 NOJ_RUN_BROWSER_E2E=1）"
fi

# ══════════════════════════════════════════════
# 3. 启动 Docker Compose 评测栈
# ══════════════════════════════════════════════
step "3/4  Docker Compose 评测栈"

if [ "$FRESH" = "1" ]; then
  info "--fresh：先清理本会话已有的容器与卷..."
  "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
fi

info "启动服务（project=$COMPOSE_PROJECT_NAME）..."
if ! "${COMPOSE[@]}" up -d --build --remove-orphans; then
  fail "docker compose up 失败；日志见下"
  "${COMPOSE[@]}" logs --tail=50 noj-core || true
  exit 1
fi
ok "评测栈已启动"

# ══════════════════════════════════════════════
# 4. 等待 noj-core 就绪
# ══════════════════════════════════════════════
step "4/4  等待 noj-core 就绪"

info "等待 noj-core API (:$E2E_CORE_PORT)..."
for i in $(seq 1 90); do
  if curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
    ok "noj-core 就绪 (:$E2E_CORE_PORT)"
    break
  fi
  sleep 2
done

if ! curl -sf "http://localhost:$E2E_CORE_PORT/health" > /dev/null 2>&1; then
  fail "noj-core 启动超时"
  "${COMPOSE[@]}" logs --tail=50 noj-core || true
  exit 1
fi

info "初始化 MinIO bucket..."
"${COMPOSE[@]}" up -d minio minio-init > /dev/null
ok "MinIO bucket 已初始化"

# ── 汇总 ──
echo ""
echo -e "${BOLD}=========================================="
echo " E2E 环境就绪（session: $NOJ_E2E_SESSION）"
echo -e "==========================================${NC}"
echo ""
echo "  ${CYAN}PostgreSQL${NC}    ${E2E_DB_URL:-<由会话清单提供>}"
echo "  ${CYAN}Redis${NC}         ${E2E_REDIS_URL:-<由会话清单提供>}"
echo "  ${CYAN}noj-core${NC}      $E2E_CORE_URL"
echo "  ${CYAN}Judge 池${NC}     $E2E_JUDGE_RESOURCE_POOLS"
echo "  ${CYAN}网络${NC}          $E2E_EVALUATOR_NETWORK"
echo ""
echo "  env:     deno run -A scripts/e2e/session.ts env --session $NOJ_E2E_SESSION"
echo "  stop:    deno run -A scripts/e2e/session.ts down --session $NOJ_E2E_SESSION"
echo "  test:    bash scripts/e2e/run-all.sh --session $NOJ_E2E_SESSION"
echo ""
