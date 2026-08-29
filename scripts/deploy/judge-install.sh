#!/usr/bin/env bash
#
# Neuro OJ 独立 Judge Worker 部署入口。
#
# 远程一键入口：
#   curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/scripts/deploy/judge-install.sh \
#     | bash -s -- install --dir /srv/noj-judge
#
# 该脚本只管理 noj-judge，不安装或替换宿主机 Docker daemon，且禁止使用共享的
# /var/run/docker.sock。rootless Docker daemon 应由运维人员按目标发行版预先准备。

set -Eeuo pipefail

DOCKER_BIN="${NOJ_JUDGE_DOCKER_BIN:-docker}"
CURL_BIN="${NOJ_JUDGE_CURL_BIN:-curl}"
PROJECT_NAME="noj-judge-standalone"
DEFAULT_REPO="https://github.com/Neuro-OJ/neuro-oj"
REPO_URL="${NOJ_JUDGE_REPO:-$DEFAULT_REPO}"
REF="${NOJ_JUDGE_REF:-main}"
TARGET_DIR="${NOJ_JUDGE_DIR:-/srv/noj-judge}"
ENV_FILE=""
COMPOSE_FILE=""
COMMAND=""
NON_INTERACTIVE=0
DOWNLOAD_ONLY=0
DRY_RUN=0
FOLLOW=0
VERSION_OVERRIDE=""
POSITIONAL=()

if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

ok() { printf "%b✓%b %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%b!%b %s\n" "$YELLOW" "$RESET" "$*" >&2; }
fail() {
  printf "%b✗%b %s\n" "$RED" "$RESET" "$*" >&2
  exit 1
}
section() { printf "\n== %s ==\n" "$*"; }

usage() {
  cat <<'EOF'
Neuro OJ 独立 Judge Worker 部署工具

用法：
  judge-install.sh install       首次配置并启动独立 Judge
  judge-install.sh install-env   检查部署依赖并输出 rootless 准备指引
  judge-install.sh check         检查配置、Redis、Docker socket 和镜像架构
  judge-install.sh start         启动 Judge（保留现有容器）
  judge-install.sh stop          停止 Judge（保留配置、缓存和 Redis 任务）
  judge-install.sh status        查看 Judge 状态和脱敏配置摘要
  judge-install.sh logs [--follow]
                                查看 Judge 日志
  judge-install.sh upgrade       拉取配置中的版本并升级
  judge-install.sh download      只从仓库下载本部署脚本

选项：
  --dir DIR              Judge 运行目录（默认 /srv/noj-judge）
  --env-file FILE        配置文件（默认 DIR/.env.judge）
  --compose-file FILE    Compose 文件（默认 DIR/docker-compose.judge.yml）
  --repo URL             GitHub 仓库地址（download 使用）
  --ref REF              仓库分支、标签或提交（download 使用，默认 main）
  --version VERSION      install/upgrade 使用的 Release 版本
  --non-interactive      不读取终端输入，必填项从环境变量或配置文件读取
  --download-only        只下载部署脚本，不执行 Docker 操作
  --dry-run              只显示动作，不修改服务
  -h, --help             显示帮助

首次 install 的非交互环境变量：
  NOJ_VERSION REDIS_URL JUDGE_DOCKER_SOCKET JUDGE_DOCKER_SOCKET_GID
  JUDGE_QUEUE RESULT_QUEUE WORK_DIR JUDGE_MAX_CONCURRENT_JUDGES
  JUDGE_IMAGE_PREFIX JUDGE_IMAGE_REGISTRY JUDGE_UID JUDGE_GID

安全约束：
  - 必须使用专用 Unix rootless Docker socket；禁止 /var/run/docker.sock 和 /run/docker.sock
  - 不自动安装、替换或配置 Docker daemon
  - 配置文件权限必须为 600 或 400；密码不会在提示和状态摘要中回显
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      install|install-env|check|start|stop|status|logs|upgrade|download)
        [[ -z "$COMMAND" ]] || fail "只能指定一个操作：$COMMAND"
        COMMAND="$1"
        ;;
      --dir)
        (($# >= 2)) || fail "--dir 需要一个目录路径"
        TARGET_DIR="$2"; shift
        ;;
      --dir=*) TARGET_DIR="${1#*=}" ;;
      --env-file)
        (($# >= 2)) || fail "--env-file 需要一个文件路径"
        ENV_FILE="$2"; shift
        ;;
      --env-file=*) ENV_FILE="${1#*=}" ;;
      --compose-file)
        (($# >= 2)) || fail "--compose-file 需要一个文件路径"
        COMPOSE_FILE="$2"; shift
        ;;
      --compose-file=*) COMPOSE_FILE="${1#*=}" ;;
      --repo)
        (($# >= 2)) || fail "--repo 需要仓库地址"
        REPO_URL="$2"; shift
        ;;
      --repo=*) REPO_URL="${1#*=}" ;;
      --ref)
        (($# >= 2)) || fail "--ref 需要分支、标签或提交"
        REF="$2"; shift
        ;;
      --ref=*) REF="${1#*=}" ;;
      --version)
        (($# >= 2)) || fail "--version 需要 Release 版本"
        VERSION_OVERRIDE="$2"; shift
        ;;
      --version=*) VERSION_OVERRIDE="${1#*=}" ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --download-only) DOWNLOAD_ONLY=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --follow|-f) FOLLOW=1 ;;
      -h|--help) usage; exit 0 ;;
      --) shift; POSITIONAL+=("$@"); break ;;
      *) POSITIONAL+=("$1") ;;
    esac
    shift
  done
  [[ -n "$COMMAND" ]] || { usage; exit 2; }
  [[ -n "$ENV_FILE" ]] || ENV_FILE="$TARGET_DIR/.env.judge"
  [[ -n "$COMPOSE_FILE" ]] || COMPOSE_FILE="$TARGET_DIR/docker-compose.judge.yml"
}

env_value() {
  local key="$1" value=""
  if [[ -f "$ENV_FILE" ]]; then
    value="$(awk -v key="$key" '
      index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
    ' "$ENV_FILE")"
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
  fi
  if [[ -z "$value" ]]; then
    value="$(printenv "$key" 2>/dev/null || true)"
  fi
  printf '%s\n' "$value"
}

set_env_value() {
  local key="$1" value="$2" tmp
  [[ -f "$ENV_FILE" ]] || fail "找不到配置文件：$ENV_FILE"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$key 不能包含换行"
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  if ! awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" >"$tmp"; then
    rm -f "$tmp"
    fail "更新配置失败"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少依赖：$1"
}

is_version() {
  [[ "$1" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]
}

is_placeholder() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  case "$value" in
    *change-me*|*changeme*|*example*|*placeholder*|*replace-me*|*your-*|latest|main|xxx*) return 0 ;;
    *) return 1 ;;
  esac
}

stat_mode() {
  local path="$1"
  stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null
}

stat_gid() {
  local path="$1"
  stat -c '%g' "$path" 2>/dev/null || stat -f '%g' "$path" 2>/dev/null
}

ensure_target_dir() {
  if [[ -e "$TARGET_DIR" && ! -d "$TARGET_DIR" ]]; then
    fail "目标路径不是目录：$TARGET_DIR"
  fi
  if [[ ! -d "$TARGET_DIR" ]]; then
    ((DRY_RUN)) || mkdir -p "$TARGET_DIR"
  fi
}

validate_existing_target() {
  [[ -d "$TARGET_DIR" ]] || return 0
  if [[ ! -f "$ENV_FILE" && ! -f "$COMPOSE_FILE" ]]; then
    if find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
      fail "目标目录非空但没有本工具配置；请指定新目录，或先明确清理后再安装：$TARGET_DIR"
    fi
  fi
}

prompt_value() {
  local key="$1" label="$2" default_value="${3:-}" secret="${4:-0}" hint="${5:-}" value
  value="$(env_value "$key")"
  [[ -n "$value" ]] && { printf '%s\n' "$value"; return 0; }
  ((NON_INTERACTIVE)) && fail "非交互安装缺少必填配置：$key"
  [[ -n "$hint" ]] && printf '  说明：%s\n' "$hint" >&2
  if [[ "$secret" == 1 ]]; then
    read -r -s -p "  $label${default_value:+ [$default_value]}：" value
    printf '\n' >&2
  else
    read -r -p "  $label${default_value:+ [$default_value]}：" value
  fi
  value="${value:-$default_value}"
  [[ -n "$value" ]] || fail "$key 不能为空"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$key 不能包含换行"
  printf '%s\n' "$value"
}

initialize_env() {
  section "配置独立 Judge"
  cat <<'EOF'
首次部署需要填写 Judge Worker 的连接信息。请按说明输入；带有默认值的项目直接回车即可。

  NOJ_VERSION：要部署的已发布镜像版本，例如 0.8.0-rc.1；不能填写 main 或 latest。
  REDIS_URL：noj-core 正在使用的 Redis 地址，Judge 必须连接同一个 Redis 和队列。
    无密码示例：redis://127.0.0.1:6379/0
    有密码示例：redis://:密码@127.0.0.1:6379/0
    这一项输入时整行不会显示在屏幕上。
  专用 Docker socket：必须是只供 Judge 使用的 rootless Docker socket，不能填写
    /run/docker.sock 或 /var/run/docker.sock。没有专用 socket 时，请先执行 install-env。

EOF
  ensure_target_dir
  validate_existing_target
  if [[ -f "$ENV_FILE" ]]; then
    chmod 600 "$ENV_FILE"
    ok "保留已有配置：$ENV_FILE"
    [[ -n "$VERSION_OVERRIDE" ]] && set_env_value NOJ_VERSION "$VERSION_OVERRIDE"
    return 0
  fi
  if ((DRY_RUN)); then
    ok "[dry-run] 将创建配置：$ENV_FILE"
    return 0
  fi

  umask 077
  local version redis_url socket socket_gid queue result work_dir concurrency prefix registry uid gid
  version="$VERSION_OVERRIDE"
  [[ -n "$version" ]] || version="$(prompt_value NOJ_VERSION "Worker 版本（例如 0.8.0-rc.1）" "" 0 "填已发布的镜像版本，不要填写 main 或 latest。")"
  redis_url="$(prompt_value REDIS_URL "Redis 连接地址" "" 1 "填 noj-core 使用的完整 Redis URL；无密码也要保留 redis:// 前缀。")"
  queue="$(prompt_value JUDGE_QUEUE "任务队列名称" "noj:judge:queue" 0 "必须与 noj-core 的任务队列名称一致，通常直接回车。")"
  result="$(prompt_value RESULT_QUEUE "结果队列名称" "noj:judge:results" 0 "必须与 noj-core 的结果队列名称一致，通常直接回车。")"
  work_dir="$(prompt_value WORK_DIR "Worker 容器工作目录" "/tmp/noj-judge" 0 "容器内部目录，通常直接回车。")"
  concurrency="$(prompt_value JUDGE_MAX_CONCURRENT_JUDGES "最大并发评测数" "2" 0 "同时运行的评测数量；机器资源较少时可填写 1。")"
  prefix="$(prompt_value JUDGE_IMAGE_PREFIX "评测镜像前缀" "noj-" 0 "题目运行时镜像的前缀，通常直接回车。")"
  registry="$(prompt_value JUDGE_IMAGE_REGISTRY "Worker 镜像仓库" "ghcr.io/neuro-oj" 0 "Worker 镜像所在仓库，不要填写末尾的 /noj-judge。")"
  socket="$(prompt_value JUDGE_DOCKER_SOCKET "专用 Docker socket 路径" "/run/noj-judge/docker.sock" 0 "必须是 Judge 专用 rootless socket，不能使用宿主机共享 socket。")"
  socket_gid="$(prompt_value JUDGE_DOCKER_SOCKET_GID "Docker socket 所属组 GID" "10001" 0 "可用 stat -c '%g' /run/noj-judge/docker.sock 查询；必须与 socket 实际 GID 一致。")"
  uid="$(prompt_value JUDGE_UID "Worker 用户 UID" "10001" 0 "容器内非 root 用户，通常直接回车。")"
  gid="$(prompt_value JUDGE_GID "Worker 用户 GID" "10001" 0 "容器内非 root 用户组，通常直接回车。")"

  cat >"$ENV_FILE" <<EOF
NOJ_VERSION=$version
REDIS_URL=$redis_url
JUDGE_QUEUE=$queue
RESULT_QUEUE=$result
WORK_DIR=$work_dir
JUDGE_MAX_CONCURRENT_JUDGES=$concurrency
JUDGE_IMAGE_PREFIX=$prefix
JUDGE_IMAGE_REGISTRY=$registry
JUDGE_DOCKER_SOCKET=$socket
JUDGE_DOCKER_SOCKET_GID=$socket_gid
JUDGE_DOCKER_HOST=unix:///run/noj-judge/docker.sock
JUDGE_REQUIRE_ISOLATED_DOCKER=true
JUDGE_UID=$uid
JUDGE_GID=$gid
JUDGE_CPU_LIMIT_MILLICORES=1000
JUDGE_MAX_EVALUATOR_TIME_MS=300000
JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS=60000
JUDGE_COMMAND_WHITELIST=python3,deno,node,bash,sh
JUDGE_ALLOW_EVALUATOR_NETWORK=false
JUDGE_EVALUATOR_NETWORK=bridge
JUDGE_ALLOW_HTTP_S3=false
SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT=60
SUPPORT_CACHE_DIR=/tmp/noj-judge/support-cache
SUPPORT_CACHE_MAX_ITEMS=500
SUPPORT_CACHE_MAX_MB=2048
EOF
  chmod 600 "$ENV_FILE"
  ok "已创建配置：$ENV_FILE"
}

write_compose() {
  if ((DRY_RUN)); then
    ok "[dry-run] 将生成 Compose 配置：$COMPOSE_FILE"
    return 0
  fi
  umask 077
  cat >"$COMPOSE_FILE" <<'EOF'
services:
  judge:
    image: "${JUDGE_IMAGE_REGISTRY:-ghcr.io/neuro-oj}/noj-judge:${NOJ_VERSION:?NOJ_VERSION is required}"
    environment:
      REDIS_URL: "${REDIS_URL:?REDIS_URL is required}"
      JUDGE_QUEUE: "${JUDGE_QUEUE:-noj:judge:queue}"
      RESULT_QUEUE: "${RESULT_QUEUE:-noj:judge:results}"
      WORK_DIR: "${WORK_DIR:-/tmp/noj-judge}"
      JUDGE_MAX_CONCURRENT_JUDGES: "${JUDGE_MAX_CONCURRENT_JUDGES:-2}"
      JUDGE_CPU_LIMIT_MILLICORES: "${JUDGE_CPU_LIMIT_MILLICORES:-1000}"
      JUDGE_MAX_EVALUATOR_TIME_MS: "${JUDGE_MAX_EVALUATOR_TIME_MS:-300000}"
      JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS: "${JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS:-60000}"
      JUDGE_IMAGE_PREFIX: "${JUDGE_IMAGE_PREFIX:-noj-}"
      JUDGE_COMMAND_WHITELIST: "${JUDGE_COMMAND_WHITELIST:-python3,deno,node,bash,sh}"
      JUDGE_ALLOW_EVALUATOR_NETWORK: "${JUDGE_ALLOW_EVALUATOR_NETWORK:-false}"
      JUDGE_EVALUATOR_NETWORK: "${JUDGE_EVALUATOR_NETWORK:-bridge}"
      JUDGE_ALLOW_HTTP_S3: "${JUDGE_ALLOW_HTTP_S3:-false}"
      JUDGE_DOCKER_HOST: "${JUDGE_DOCKER_HOST:-unix:///run/noj-judge/docker.sock}"
      JUDGE_REQUIRE_ISOLATED_DOCKER: "true"
      SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "${SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT:-60}"
      SUPPORT_CACHE_DIR: "${SUPPORT_CACHE_DIR:-/tmp/noj-judge/support-cache}"
      SUPPORT_CACHE_MAX_ITEMS: "${SUPPORT_CACHE_MAX_ITEMS:-500}"
      SUPPORT_CACHE_MAX_MB: "${SUPPORT_CACHE_MAX_MB:-2048}"
    volumes:
      - "${JUDGE_DOCKER_SOCKET:?JUDGE_DOCKER_SOCKET is required}:/run/noj-judge/docker.sock:ro"
      - judge-cache:/tmp/noj-judge
    user: "${JUDGE_UID:-10001}:${JUDGE_GID:-10001}"
    group_add:
      - "${JUDGE_DOCKER_SOCKET_GID:?JUDGE_DOCKER_SOCKET_GID is required}"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped

volumes:
  judge-cache:
    name: noj-judge-standalone-cache
EOF
  chmod 600 "$COMPOSE_FILE"
  ok "已生成 Compose 配置：$COMPOSE_FILE"
}

check_base_environment() {
  section "检查主机环境"
  [[ "$(uname -s)" == "Linux" ]] || fail "独立 Judge 部署目前只支持 Linux"
  local machine arch
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "不支持的 CPU 架构：${machine}（当前支持 x86_64/amd64 与 ARM64）" ;;
  esac
  require_command "$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || fail "Docker daemon 未运行或当前用户无权限"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 || fail "Docker Compose v2 不可用"
  ok "Linux/${arch}、Docker daemon 和 Compose 可用"
  if [[ -d "$TARGET_DIR" ]]; then
    local available_kb memory_kb
    available_kb="$(df -Pk "$TARGET_DIR" | awk 'NR==2 {print $4}')"
    [[ "$available_kb" =~ ^[0-9]+$ ]] || fail "无法读取目标目录磁盘空间：$TARGET_DIR"
    ((available_kb >= 5242880)) || warn "目标目录可用空间少于 5 GiB，评测镜像和缓存可能不足"
    if [[ -r /proc/meminfo ]]; then
      memory_kb="$(awk '/MemAvailable:/ {print $2; exit}' /proc/meminfo)"
      [[ "$memory_kb" =~ ^[0-9]+$ ]] && ((memory_kb >= 524288)) ||
        warn "可用内存少于 512 MiB，建议降低 Judge 并发"
    fi
  fi
}

check_config_values() {
  local key value missing=0
  local required=(NOJ_VERSION REDIS_URL JUDGE_QUEUE RESULT_QUEUE WORK_DIR
    JUDGE_MAX_CONCURRENT_JUDGES JUDGE_IMAGE_PREFIX JUDGE_IMAGE_REGISTRY
    JUDGE_DOCKER_SOCKET JUDGE_DOCKER_SOCKET_GID JUDGE_UID JUDGE_GID)
  for key in "${required[@]}"; do
    value="$(env_value "$key")"
    if is_placeholder "$value"; then
      printf "  - %s 未配置或仍是占位值\n" "$key" >&2
      missing=1
    fi
  done
  ((missing == 0)) || fail "Judge 配置未完成，请修复上面的配置项"
  is_version "$(env_value NOJ_VERSION)" || fail "NOJ_VERSION 必须是不可变 Release 标签，如 v0.1.0"
  [[ "$(env_value JUDGE_MAX_CONCURRENT_JUDGES)" =~ ^[1-9][0-9]*$ ]] ||
    fail "JUDGE_MAX_CONCURRENT_JUDGES 必须是正整数"
  [[ "$(env_value JUDGE_DOCKER_SOCKET_GID)" =~ ^[0-9]+$ ]] ||
    fail "JUDGE_DOCKER_SOCKET_GID 必须是数字"
  [[ "$(env_value JUDGE_UID)" =~ ^[0-9]+$ && "$(env_value JUDGE_GID)" =~ ^[0-9]+$ ]] ||
    fail "JUDGE_UID 和 JUDGE_GID 必须是数字"
  [[ "$(env_value JUDGE_DOCKER_HOST)" == unix:///* ]] ||
    fail "JUDGE_DOCKER_HOST 必须使用 unix:// endpoint"
  [[ "$(env_value JUDGE_DOCKER_HOST)" == unix:///run/noj-judge/docker.sock ]] ||
    fail "JUDGE_DOCKER_HOST 必须为容器内专用 endpoint：unix:///run/noj-judge/docker.sock"
  [[ "$(env_value JUDGE_REQUIRE_ISOLATED_DOCKER)" == true ]] ||
    fail "JUDGE_REQUIRE_ISOLATED_DOCKER 必须为 true"
}

check_socket() {
  local socket_path socket_gid socket_mode configured_gid
  socket_path="$(env_value JUDGE_DOCKER_SOCKET)"
  case "$socket_path" in
    /var/run/docker.sock|/run/docker.sock)
      fail "禁止使用应用宿主机 Docker socket：${socket_path}；请准备专用 rootless socket"
      ;;
  esac
  [[ "$socket_path" == /* ]] || fail "JUDGE_DOCKER_SOCKET 必须是绝对路径"
  [[ "$socket_path" != *:* ]] || fail "JUDGE_DOCKER_SOCKET 必须是本机 Unix socket 路径"
  [[ -S "$socket_path" ]] || fail "专用 Docker socket 不存在或不是 Unix socket：${socket_path}"
  [[ -r "$socket_path" && -w "$socket_path" ]] ||
    fail "当前用户无法读写专用 Docker socket：${socket_path}"
  socket_gid="$(stat_gid "$socket_path")"
  configured_gid="$(env_value JUDGE_DOCKER_SOCKET_GID)"
  [[ "$socket_gid" == "$configured_gid" ]] ||
    fail "Docker socket GID=${socket_gid} 与配置 JUDGE_DOCKER_SOCKET_GID=${configured_gid} 不一致"
  socket_mode="$(stat_mode "$socket_path")"
  DOCKER_HOST="unix://${socket_path}" "$DOCKER_BIN" info >/dev/null 2>&1 ||
    fail "专用 rootless Docker daemon 不可连接：${socket_path}"
  ok "专用 rootless Docker socket 可用（GID=${socket_gid}，权限=${socket_mode}）"
}

redis_host() {
  local url="$(env_value REDIS_URL)"
  url="${url#*://}"
  url="${url#*@}"
  url="${url%%/*}"
  url="${url%%:*}"
  printf '%s\n' "${url:-未知主机}"
}

check_redis() {
  local url="$(env_value REDIS_URL)"
  [[ "$url" =~ ^rediss?:// ]] || fail "REDIS_URL 必须使用 redis:// 或 rediss://"
  section "检查 Redis"
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -u "$url" ping >/dev/null 2>&1 ||
      fail "Redis 连接失败：$(redis_host)（密码不会显示）"
  else
    REDIS_URL="$url" "$DOCKER_BIN" run --rm --network host -e REDIS_URL redis:7-alpine \
      sh -c 'redis-cli -u "$REDIS_URL" ping' >/dev/null 2>&1 ||
      fail "Redis 连接失败：$(redis_host)；系统未安装 redis-cli，已尝试使用临时 Redis 客户端"
  fi
  ok "Redis 可连接：$(redis_host)"
}

image_name() {
  printf '%s/noj-judge:%s\n' "$(env_value JUDGE_IMAGE_REGISTRY)" "$(env_value NOJ_VERSION)"
}

local_image_arch() {
  "$DOCKER_BIN" image inspect "$(image_name)" --format '{{.Architecture}}' 2>/dev/null || true
}

check_image_architecture() {
  local machine expected image details inspect_file local_image_arch_value
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) expected=amd64 ;;
    aarch64|arm64) expected=arm64 ;;
    *) return 1 ;;
  esac
  image="$(image_name)"
  local_image_arch_value="$(local_image_arch)"
  if [[ -n "$local_image_arch_value" ]]; then
    [[ "$local_image_arch_value" == "$expected" ]] ||
      fail "本地 Worker 镜像架构为 ${local_image_arch_value}，当前主机需要 ${expected}：${image}"
    ok "Worker 镜像已存在且架构匹配：${expected}"
    return 0
  fi
  inspect_file="$(mktemp "${TMPDIR:-/tmp}/noj-judge-image-inspect.XXXXXX")"
  if "$DOCKER_BIN" buildx imagetools inspect "$image" >"$inspect_file" 2>/dev/null; then
    details="$(<"$inspect_file")"
    rm -f "$inspect_file"
    grep -Eiq "linux/${expected}|Architecture:[[:space:]]+${expected}" <<<"$details" ||
      fail "Worker 镜像没有当前主机架构 linux/${expected}：${image}"
    ok "Worker 镜像 manifest 包含 linux/${expected}"
  else
    rm -f "$inspect_file"
    warn "无法预先读取 Worker manifest，将由 docker pull 报告网络、认证或架构错误：${image}"
  fi
}

check_configuration() {
  [[ -f "$ENV_FILE" ]] || fail "找不到配置文件：$ENV_FILE，请先执行 install"
  [[ -f "$COMPOSE_FILE" ]] || fail "找不到 Compose 配置：$COMPOSE_FILE，请先执行 install"
  local mode
  mode="$(stat_mode "$ENV_FILE")"
  [[ "$mode" == 600 || "$mode" == 400 ]] ||
    fail "配置文件权限必须为 600 或 400：$ENV_FILE"
  check_config_values
  check_socket
  if ((DRY_RUN)); then
    ok "[dry-run] 跳过 Redis、镜像和 Compose 实际连接检查"
  else
    check_redis
    check_image_architecture
    "$DOCKER_BIN" compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
      -f "$COMPOSE_FILE" config --quiet || fail "独立 Judge Compose 配置无效"
  fi
  ok "Judge 配置检查通过"
}

run_compose() {
  if ((DRY_RUN)); then
    printf '[dry-run] docker compose --project-name %s --env-file %s -f %s' \
      "$PROJECT_NAME" "$ENV_FILE" "$COMPOSE_FILE"
    printf ' %s\n' "$*"
    return 0
  fi
  "$DOCKER_BIN" compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" "$@"
}

download_script() {
  require_command "$CURL_BIN"
  [[ "$REPO_URL" =~ ^https://github\.com/[^/]+/[^/]+/?$ ]] ||
    fail "--repo 目前只支持 https://github.com/组织/仓库"
  local slug url tmp download_dir
  slug="${REPO_URL#https://github.com/}"
  slug="${slug%/}"
  slug="${slug%.git}"
  url="https://raw.githubusercontent.com/$slug/$REF/scripts/deploy/judge-install.sh"
  download_dir="$TARGET_DIR"
  if ((DRY_RUN)); then
    ok "[dry-run] 将下载部署脚本：$url -> $download_dir/judge-install.sh"
    return 0
  fi
  [[ -d "$download_dir" ]] || { ((DRY_RUN)) || mkdir -p "$download_dir"; }
  tmp="$(mktemp "${download_dir}/.judge-install.XXXXXX")"
  if ! "$CURL_BIN" -fsSL --retry 3 "$url" -o "$tmp"; then
    rm -f "$tmp"
    fail "下载部署脚本失败，请检查仓库、ref 和网络：$url"
  fi
  bash -n "$tmp" || { rm -f "$tmp"; fail "下载内容不是有效 Bash 脚本：$url"; }
  chmod 700 "$tmp"
  mv "$tmp" "$download_dir/judge-install.sh"
  ok "已下载部署脚本：$download_dir/judge-install.sh"
}

install_env() {
  section "检查 Judge 部署依赖"
  [[ "$(uname -s)" == Linux ]] || fail "独立 Judge 部署目前只支持 Linux"
  require_command "$CURL_BIN"
  require_command "$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || fail "Docker daemon 未运行或当前用户无权限"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 || fail "Docker Compose v2 不可用"
  ok "Docker daemon 与 Compose 可用"
  cat <<'EOF'

请确认已准备以下隔离条件：
  1. 只服务于 Judge 的 rootless Docker daemon；
  2. 独立 Unix socket（例如 /run/noj-judge/docker.sock）；
  3. Worker 用户的 UID/GID 及 socket group 权限；
  4. 与 noj-core 使用同一 Redis、任务队列和结果队列。

本工具不会自动安装或替换 Docker daemon，也不会把 /var/run/docker.sock 提供给 Judge。
EOF
}

install_worker() {
  initialize_env
  write_compose
  check_base_environment
  check_configuration
  section "启动独立 Judge"
  run_compose pull
  run_compose up -d --remove-orphans
  ok "独立 Judge 已启动（Compose project: ${PROJECT_NAME}）"
}

start_worker() {
  check_base_environment
  check_configuration
  run_compose up -d --remove-orphans
  ok "独立 Judge 已启动"
}

upgrade_worker() {
  [[ -f "$ENV_FILE" ]] || fail "找不到配置文件：$ENV_FILE，请先执行 install"
  [[ -n "$VERSION_OVERRIDE" ]] && set_env_value NOJ_VERSION "$VERSION_OVERRIDE"
  write_compose
  check_base_environment
  check_configuration
  section "升级独立 Judge"
  run_compose pull
  run_compose up -d --remove-orphans
  ok "独立 Judge 已升级；配置、缓存和 Redis 任务已保留"
}

status_worker() {
  check_base_environment
  check_configuration
  printf '版本：%s\n' "$(env_value NOJ_VERSION)"
  printf 'Redis 主机：%s\n' "$(redis_host)"
  printf '任务队列：%s\n' "$(env_value JUDGE_QUEUE)"
  printf '结果队列：%s\n' "$(env_value RESULT_QUEUE)"
  printf 'Docker socket：%s\n' "$(env_value JUDGE_DOCKER_SOCKET)"
  run_compose ps
}

logs_worker() {
  check_base_environment
  [[ -f "$ENV_FILE" ]] || fail "找不到配置文件：$ENV_FILE，请先执行 install"
  local args=(logs --tail=200)
  ((FOLLOW)) && args+=(--follow)
  run_compose "${args[@]}"
}

stop_worker() {
  [[ -f "$ENV_FILE" ]] || fail "找不到配置文件：$ENV_FILE，请先执行 install"
  run_compose stop
  ok "独立 Judge 已停止；配置、缓存和 Redis 任务已保留"
}

main() {
  parse_args "$@"
  if ((DOWNLOAD_ONLY)) || [[ "$COMMAND" == download ]]; then
    download_script
    exit 0
  fi
  case "$COMMAND" in
    install-env) install_env ;;
    install)
      check_base_environment
      initialize_env
      write_compose
      check_configuration
      run_compose pull
      run_compose up -d --remove-orphans
      ok "独立 Judge 已启动（Compose project: ${PROJECT_NAME}）"
      ;;
    check) check_base_environment; check_configuration ;;
    start) start_worker ;;
    stop) stop_worker ;;
    status) status_worker ;;
    logs) logs_worker ;;
    upgrade) upgrade_worker ;;
    download) download_script ;;
  esac
}

main "$@"
