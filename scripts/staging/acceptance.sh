#!/usr/bin/env bash
# Neuro OJ 生产候选版本 staging 验收门禁。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_FILE="${STAGING_ENV_FILE:-$ROOT_DIR/.env.prod}"
COMPOSE_FILE="${STAGING_COMPOSE_FILE:-$ROOT_DIR/docker-compose.prod.yml}"
DOCKER_BIN="${STAGING_DOCKER_BIN:-docker}"
PROJECT_NAME="${STAGING_PROJECT_NAME:-noj-staging}"
IMAGE_REGISTRY="${STAGING_IMAGE_REGISTRY:-ghcr.io/neuro-oj}"
IMAGE_TAG="${STAGING_IMAGE_TAG:-}"
BASE_URL="${STAGING_BASE_URL:-}"
CORS_ORIGIN="${STAGING_CORS_ORIGIN:-}"
ARTIFACT_DIR="${STAGING_ARTIFACT_DIR:-}"
KEEP_STACK="${STAGING_KEEP_STACK:-0}"
SKIP_BUILD="${STAGING_SKIP_BUILD:-0}"
ALLOW_HTTP="${STAGING_ALLOW_HTTP:-0}"
COMMAND=""
CHECKED=0

usage() {
  cat <<'EOF'
用法：scripts/staging/acceptance.sh <命令> [选项]

命令：
  check        检查候选版本、凭据、Docker 与 Compose 配置
  build        构建七个生产候选镜像
  up           启动生产 Compose，并等待健康检查完成
  verify-edge  验证 HTTPS、healthz、Cookie 与 CORS
  smoke        执行认证、题包、对象存储、评测、SSE 与重测验收
  all          依次执行 check、build、up、verify-edge、smoke
  down         停止 staging 服务（保留数据卷）

选项：
  --env-file FILE       staging/生产环境变量文件
  --compose-file FILE   Compose 文件
  --artifact-dir DIR    验收报告与失败诊断目录
  --keep-stack          all 成功后保留服务
  --skip-build          all 不重新构建镜像
  --allow-http          仅本地调试时允许 HTTP 验收
EOF
}

log() {
  printf '[staging] %s\n' "$*"
}

warn() {
  printf '[staging][警告] %s\n' "$*" >&2
}

die() {
  printf '[staging][失败] %s\n' "$*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || die "文件不存在：$1"
}

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { sub("^" key "=", ""); print; exit }' "$ENV_FILE"
}

resolve_admin_email() {
  local value="${STAGING_ADMIN_EMAIL:-${ADMIN_EMAIL:-}}"
  [[ -n "$value" ]] || value="$(env_value STAGING_ADMIN_EMAIL)"
  [[ -n "$value" ]] || value="$(env_value ADMIN_EMAIL)"
  printf '%s' "$value"
}

resolve_admin_password() {
  local value="${STAGING_ADMIN_PASSWORD:-${ADMIN_PASS:-}}"
  [[ -n "$value" ]] || value="$(env_value STAGING_ADMIN_PASSWORD)"
  [[ -n "$value" ]] || value="$(env_value ADMIN_PASS)"
  printf '%s' "$value"
}

compose() {
  NOJ_VERSION="$IMAGE_TAG" \
    NOJ_IMAGE_REGISTRY="$IMAGE_REGISTRY" \
    JUDGE_IMAGE_BASE="$IMAGE_REGISTRY/" \
    "$DOCKER_BIN" compose \
    --project-name "$PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

check_source() {
  if [[ "${STAGING_ALLOW_DIRTY:-0}" == "1" ]]; then
    warn "STAGING_ALLOW_DIRTY=1：跳过工作树洁净检查，仅允许本地调试使用"
  else
    [[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] \
      || die "候选版本工作树不干净，请提交或清理后再验收"
  fi

  local branch tag ref
  branch="$(git -C "$ROOT_DIR" symbolic-ref --short HEAD 2>/dev/null || true)"
  tag="$(git -C "$ROOT_DIR" tag --points-at HEAD | head -n 1)"
  ref="${branch:-${tag:-detached}}"
  if [[ "${STAGING_ALLOW_ANY_CLEAN_REF:-0}" != "1" ]]; then
    if [[ -z "$branch" && -n "$tag" ]]; then
      :
    else
      [[ "$branch" == "main" || "$branch" == release/* ]] \
        || die "当前来源为 '$ref'，只允许 main、release/* 或版本标签候选"
    fi
  fi
  printf '%s\n' "$(git -C "$ROOT_DIR" rev-parse --short HEAD)" > "$ARTIFACT_DIR/commit.txt"
  printf '%s\n' "${ref:-detached}" > "$ARTIFACT_DIR/ref.txt"
}

check_config() {
  require_file "$ENV_FILE"
  require_file "$COMPOSE_FILE"
  [[ "$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")" == "600" || \
    "$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")" == "400" ]] \
    || die "环境文件权限必须为 600 或 400：$ENV_FILE"
  [[ -n "$IMAGE_TAG" && "$IMAGE_TAG" != "latest" ]] \
    || die "必须使用明确的 STAGING_IMAGE_TAG，禁止使用 latest 作为验收版本"
  case "$IMAGE_TAG" in
    change-me-*|staging-candidate) die "镜像版本仍是模板占位值：$IMAGE_TAG" ;;
  esac
  [[ "$IMAGE_REGISTRY" != */ ]] || die "STAGING_IMAGE_REGISTRY 不应以 / 结尾"

  local key value
  for key in POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET TFA_ENCRYPTION_KEY \
    NOJ_LLM_SERVICE_TOKEN NOJ_LLM_STORE_KEY S3_ACCESS_KEY S3_SECRET_KEY ADMIN_PASS; do
    value="$(env_value "$key")"
    [[ -n "$value" ]] || die "环境文件缺少必填值：$key"
    case "$value" in
      替换*|至少*|change-me-*|your-*) die "环境文件仍含占位值：$key" ;;
    esac
  done
}

check_dependencies() {
  command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "找不到 Docker CLI：$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || die "Docker daemon 不可用"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 || die "Docker Compose 不可用"
  compose config --quiet || die "Compose 配置校验失败"
}

write_metadata() {
  mkdir -p "$ARTIFACT_DIR"
  {
    printf 'image_registry=%s\n' "$IMAGE_REGISTRY"
    printf 'image_tag=%s\n' "$IMAGE_TAG"
    printf 'base_url=%s\n' "$BASE_URL"
    printf 'timestamp=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$ARTIFACT_DIR/metadata.txt"
  cat > "$ARTIFACT_DIR/known-limits.txt" <<'EOF'
外部 TLS 终止层、DNS 与证书续期不由本脚本管理。
脚本不会自动执行 GitHub Release、生产升级或发布批准。
验收成功默认停止服务但保留数据卷，数据清理与备份仍需按运维流程执行。
EOF
}

capture_diagnostics() {
  mkdir -p "$ARTIFACT_DIR"
  log "正在保存 staging 诊断：$ARTIFACT_DIR"
  compose ps -a > "$ARTIFACT_DIR/compose-ps.txt" 2>&1 || true
  compose ps migrate > "$ARTIFACT_DIR/migration-status.txt" 2>&1 || true
  compose logs --no-color --tail=500 > "$ARTIFACT_DIR/compose-logs.txt" 2>&1 || true
  "$DOCKER_BIN" info > "$ARTIFACT_DIR/docker-info.txt" 2>&1 || true
  write_metadata || true
}

on_exit() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    capture_diagnostics
    printf '[staging] 验收失败，诊断已保存到：%s\n' "$ARTIFACT_DIR" >&2
  fi
  exit "$status"
}

check_all() {
  mkdir -p "$ARTIFACT_DIR"
  check_config
  check_source
  check_dependencies
  write_metadata
  CHECKED=1
  log "候选版本与 Compose 配置检查通过"
}

build_images() {
  [[ "$CHECKED" == "1" ]] || check_all
  local image context file
  while IFS='|' read -r image context file; do
    log "构建 $IMAGE_REGISTRY/$image:$IMAGE_TAG"
    "$DOCKER_BIN" build --pull \
      --tag "$IMAGE_REGISTRY/$image:$IMAGE_TAG" \
      --file "$ROOT_DIR/$file" \
      "$ROOT_DIR/$context"
    if [[ "$image" == "noj-evaluator-python" || "$image" == "noj-solution-python" || "$image" == "noj-solution-ai" ]]; then
      "$DOCKER_BIN" tag \
        "$IMAGE_REGISTRY/$image:$IMAGE_TAG" \
        "$IMAGE_REGISTRY/$image:latest"
    fi
  done <<'EOF'
noj-core|noj-core|noj-core/Dockerfile
noj-ui|noj-ui|noj-ui/Dockerfile
noj-judge|noj-judge|noj-judge/Dockerfile
noj-llm-gateway|noj-llm-gateway|noj-llm-gateway/Dockerfile
noj-evaluator-python|noj-judge|noj-judge/docker/evaluator-python/Dockerfile
noj-solution-python|noj-judge|noj-judge/docker/solution-python/Dockerfile
noj-solution-ai|noj-judge|noj-judge/docker/solution-ai/Dockerfile
EOF
  log "七个生产候选镜像构建完成"
}

start_stack() {
  [[ "$CHECKED" == "1" ]] || check_all
  compose up -d --wait --wait-timeout 300 --remove-orphans
  compose ps migrate > "$ARTIFACT_DIR/migration-status.txt" 2>&1 \
    || die "无法读取数据库迁移服务状态"
  log "staging 服务已启动并通过 Compose 健康等待"
}

verify_edge() {
  [[ "$CHECKED" == "1" ]] || check_all
  [[ -n "$BASE_URL" ]] || die "必须设置 STAGING_BASE_URL"
  [[ -n "$CORS_ORIGIN" ]] || die "必须设置 STAGING_CORS_ORIGIN"
  if [[ "$BASE_URL" != https://* && "$ALLOW_HTTP" != "1" ]]; then
    die "生产 staging 必须使用 HTTPS；本地调试请显式传 --allow-http"
  fi
  command -v curl >/dev/null 2>&1 || die "找不到 curl"

  local health_body health_status headers cors_headers login_status origin_status
  health_body="$ARTIFACT_DIR/health.json"
  health_status="$(curl --fail --silent --show-error --output "$health_body" --write-out '%{http_code}' "$BASE_URL/healthz")" \
    || die "healthz 请求失败"
  [[ "$health_status" == "200" ]] || die "healthz 返回 HTTP $health_status"
  grep -q '"status"' "$health_body" || die "healthz 响应缺少 status"

  local admin_email admin_password
  admin_email="$(resolve_admin_email)"
  admin_password="$(resolve_admin_password)"
  [[ -n "$admin_email" && -n "$admin_password" ]] || die "缺少 staging 管理员凭据（STAGING_ADMIN_EMAIL/STAGING_ADMIN_PASSWORD）"

  headers="$(mktemp)"
  login_status="$(curl --fail --silent --show-error \
    --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --data "$(printf '{\"login\":\"%s\",\"password\":\"%s\"}' "$admin_email" "$admin_password")" \
    "$BASE_URL/api/v1/auth/login")" || die "管理员登录请求失败"
  [[ "$login_status" == "200" ]] || die "管理员登录返回 HTTP $login_status"
  grep -qi 'Set-Cookie:.*noj:token=' "$headers" || die "登录响应缺少 noj:token Cookie"
  grep -qi 'Set-Cookie:.*HttpOnly' "$headers" || die "noj:token Cookie 缺少 HttpOnly"
  if [[ "$BASE_URL" == https://* ]]; then
    grep -qi 'Set-Cookie:.*Secure' "$headers" || die "HTTPS 登录响应缺少 Secure Cookie"
  fi
  grep -qi 'Set-Cookie:.*SameSite=Lax' "$headers" || die "Cookie 缺少 SameSite=Lax"
  rm -f "$headers"

  cors_headers="$(mktemp)"
  origin_status="$(curl --silent --show-error --dump-header "$cors_headers" \
    --output /dev/null --write-out '%{http_code}' --header "Origin: $CORS_ORIGIN" \
    "$BASE_URL/api/v1/auth/me")" || die "CORS 探测请求失败"
  [[ "$origin_status" != "000" ]] || die "CORS 探测未建立连接"
  grep -Fqi "Access-Control-Allow-Origin: $CORS_ORIGIN" "$cors_headers" \
    || die "CORS 响应未返回指定的 Access-Control-Allow-Origin"
  rm -f "$cors_headers"
  log "HTTPS、healthz、Cookie 与 CORS 验证通过"
}

run_smoke() {
  [[ "$CHECKED" == "1" ]] || check_all
  [[ -n "$BASE_URL" ]] || die "必须设置 STAGING_BASE_URL"
  command -v deno >/dev/null 2>&1 || die "找不到 Deno"
  (
    cd "$ROOT_DIR/noj-tests"
    NOJ_RUN_E2E=1 \
      E2E_BASE_URL="$BASE_URL" \
      E2E_ADMIN_EMAIL="$(resolve_admin_email)" \
      E2E_ADMIN_PASS="$(resolve_admin_password)" \
      E2E_EVALUATOR_IMAGE="$IMAGE_REGISTRY/noj-evaluator-python" \
      E2E_SOLUTION_IMAGE="$IMAGE_REGISTRY/noj-solution-python" \
      deno test -A --no-check e2e/staging-smoke.test.ts 2>&1 | tee "$ARTIFACT_DIR/smoke.log"
  )
  log "业务 staging smoke test 全部通过"
}

run_all() {
  check_all
  [[ "$SKIP_BUILD" == "1" ]] || build_images
  start_stack
  verify_edge
  run_smoke
  if [[ "$KEEP_STACK" != "1" ]]; then
    compose down --remove-orphans
    log "验收成功，已停止 staging 服务并保留数据卷"
  else
    log "验收成功，因 --keep-stack 保留 staging 服务"
  fi
  printf 'success\n' > "$ARTIFACT_DIR/acceptance-result.txt"
}

parse_args() {
  [[ "$#" -gt 0 ]] || { usage; exit 2; }
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage
    exit 0
  fi
  COMMAND="$1"
  shift
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --env-file) [[ "$#" -ge 2 ]] || die "--env-file 缺少参数"; ENV_FILE="$2"; shift 2 ;;
      --compose-file) [[ "$#" -ge 2 ]] || die "--compose-file 缺少参数"; COMPOSE_FILE="$2"; shift 2 ;;
      --artifact-dir) [[ "$#" -ge 2 ]] || die "--artifact-dir 缺少参数"; ARTIFACT_DIR="$2"; shift 2 ;;
      --keep-stack) KEEP_STACK=1; shift ;;
      --skip-build) SKIP_BUILD=1; shift ;;
      --allow-http) ALLOW_HTTP=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知选项：$1" ;;
    esac
  done
}

parse_args "$@"
if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="$(env_value NOJ_VERSION)"
fi
if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == "latest" ]]; then
  IMAGE_TAG="staging-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date -u '+%Y%m%d%H%M%S')"
fi
if [[ -z "$ARTIFACT_DIR" ]]; then
  ARTIFACT_DIR="$ROOT_DIR/artifacts/staging/$IMAGE_TAG"
fi

trap on_exit EXIT

case "$COMMAND" in
  check) check_all ;;
  build) build_images ;;
  up) start_stack ;;
  verify-edge) verify_edge ;;
  smoke) run_smoke ;;
  all) run_all ;;
  down)
    check_config
    compose down --remove-orphans
    log "staging 服务已停止，数据卷已保留"
    ;;
  help) usage ;;
  *) die "未知命令：$COMMAND" ;;
esac
