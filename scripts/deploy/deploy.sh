#!/usr/bin/env bash
#
# Neuro OJ 生产部署入口。
#
# 用法：
#   bash scripts/deploy/deploy.sh install
#   bash scripts/deploy/deploy.sh start
#   bash scripts/deploy/deploy.sh upgrade
#   bash scripts/deploy/deploy.sh stop
#   bash scripts/deploy/deploy.sh status
#   bash scripts/deploy/deploy.sh logs [service] [--follow]
#   bash scripts/deploy/deploy.sh backup
#
# 脚本只封装 docker-compose.prod.yml，不执行 down -v、不删除数据卷，
# 也不会 source 环境文件，避免环境变量中的特殊字符触发 shell 解析。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.prod"
ENV_TEMPLATE="$REPO_ROOT/.env.prod.example"
COMPOSE_FILE="$REPO_ROOT/docker-compose.prod.yml"
BACKUP_DIR="$REPO_ROOT/backups"
DOCKER_BIN="${NOJ_DEPLOY_DOCKER_BIN:-docker}"
DRY_RUN=0
FOLLOW=0

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
Neuro OJ 生产部署工具

用法：
  deploy.sh install                  首次初始化配置并部署
  deploy.sh start                    启动生产服务
  deploy.sh upgrade                  拉取 NOJ_VERSION 并升级服务
  deploy.sh stop                     停止服务（保留数据卷）
  deploy.sh status                   查看服务状态
  deploy.sh logs [service]           查看最近日志
  deploy.sh logs [service] --follow  持续查看日志
  deploy.sh backup                   创建 PostgreSQL 备份

选项：
  --env-file FILE       使用指定的生产环境文件
  --compose-file FILE   使用指定的 Compose 文件
  --backup-dir DIR      指定备份目录（默认 ./backups）
  --dry-run             只检查并显示将执行的操作，不修改服务或文件
  -h, --help            显示帮助

环境变量：
  NOJ_DEPLOY_DOCKER_BIN  仅用于测试，指定 Docker CLI 路径
EOF
}

parse_args() {
  COMMAND=""
  POSITIONAL=()
  while (($# > 0)); do
    case "$1" in
      install|start|upgrade|stop|status|logs|backup)
        if [[ -n "$COMMAND" ]]; then
          POSITIONAL+=("$1")
        else
          COMMAND="$1"
        fi
        ;;
      --env-file)
        (($# >= 2)) || fail "--env-file 需要一个文件路径"
        ENV_FILE="$2"
        shift
        ;;
      --env-file=*) ENV_FILE="${1#*=}" ;;
      --compose-file)
        (($# >= 2)) || fail "--compose-file 需要一个文件路径"
        COMPOSE_FILE="$2"
        shift
        ;;
      --compose-file=*) COMPOSE_FILE="${1#*=}" ;;
      --backup-dir)
        (($# >= 2)) || fail "--backup-dir 需要一个目录路径"
        BACKUP_DIR="$2"
        shift
        ;;
      --backup-dir=*) BACKUP_DIR="${1#*=}" ;;
      --follow|-f) FOLLOW=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      --) shift; POSITIONAL+=("$@"); break ;;
      *) POSITIONAL+=("$1") ;;
    esac
    shift
  done
  [[ -n "$COMMAND" ]] || { usage; exit 2; }
}

env_value() {
  local key="$1" value
  [[ -f "$ENV_FILE" ]] || return 0
  value="$(awk -v key="$key" '
    index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$ENV_FILE")"
  case "$value" in
    "\""*"\""|"'"*"'") value="${value:1:${#value}-2}" ;;
  esac
  printf '%s\n' "$value"
}

set_env_value() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  if ! awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" >"$tmp"; then
    rm -f "$tmp"
    fail "更新生产配置失败"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

generate_secret() {
  command -v openssl >/dev/null 2>&1 ||
    fail "首次初始化需要 openssl，用于生成随机密钥"
  openssl rand -hex 32 | tr -d '\n'
}

initialize_env() {
  section "初始化生产配置"
  [[ -f "$ENV_TEMPLATE" ]] || fail "找不到生产配置模板：$ENV_TEMPLATE"
  if [[ -e "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || fail "生产配置路径不是普通文件：$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "保留已有配置：$ENV_FILE"
    return 0
  fi

  if ((DRY_RUN)); then
    ok "[dry-run] 将从 $ENV_TEMPLATE 创建 $ENV_FILE"
    return 0
  fi

  umask 077
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  local key value
  for key in \
    POSTGRES_PASSWORD \
    REDIS_PASSWORD \
    MINIO_ROOT_PASSWORD \
    S3_SECRET_KEY \
    JWT_SECRET \
    TFA_ENCRYPTION_KEY \
    NOJ_LLM_SERVICE_TOKEN \
    NOJ_LLM_STORE_KEY; do
    value="$(generate_secret)"
    set_env_value "$key" "$value"
  done
  set_env_value MINIO_ROOT_USER "nojminio$(openssl rand -hex 6)"
  set_env_value S3_ACCESS_KEY "nojs3$(openssl rand -hex 6)"

  ok "已创建并保护 $ENV_FILE"
  warn "请填写 NOJ_VERSION、DOMAIN、APP_URL、邮件 Provider、管理员账号和 Judge Docker socket"
  warn "配置完成后重新执行：bash scripts/deploy/deploy.sh install"
  exit 2
}

check_file_permissions() {
  local mode
  mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  [[ -n "$mode" ]] || fail "无法读取生产配置文件权限：$ENV_FILE"
  if [[ "$mode" != "600" && "$mode" != "400" ]]; then
    fail "生产配置文件权限必须为 600 或 400：$ENV_FILE"
  fi
}

is_placeholder() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  case "$value" in
    *change-me*|*change-this*|*changeme*|*example*|*placeholder*|*replace-me*|*your-*|test|xxx*) return 0 ;;
    *) return 1 ;;
  esac
}

check_required_values() {
  local key value
  local required_keys=(
    NOJ_VERSION APP_URL CORS_ALLOWED_ORIGINS TRUSTED_PROXIES
    POSTGRES_PASSWORD REDIS_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD
    S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_ENDPOINT STORAGE_PROVIDER
    JWT_SECRET TFA_ENCRYPTION_KEY NOJ_LLM_SERVICE_TOKEN NOJ_LLM_STORE_KEY
    ADMIN_EMAIL ADMIN_PASS EMAIL_PROVIDER JUDGE_DOCKER_SOCKET JUDGE_DOCKER_SOCKET_GID
  )
  local missing=0
  for key in "${required_keys[@]}"; do
    value="$(env_value "$key")"
    if is_placeholder "$value"; then
      printf "  - %s 未配置或仍是占位值\n" "$key" >&2
      missing=1
    fi
  done
  ((missing == 0)) || fail "生产配置未完成，请先修复上面的配置项"

  case "$(env_value EMAIL_PROVIDER)" in
    aliyun)
      for key in ALIBABA_ACCESS_KEY_ID ALIBABA_ACCESS_KEY_SECRET ALIBABA_FROM_EMAIL; do
        value="$(env_value "$key")"
        is_placeholder "$value" && { printf "  - %s 未配置或仍是占位值\n" "$key" >&2; missing=1; }
      done
      ;;
    tencent)
      for key in TENCENT_SECRET_ID TENCENT_SECRET_KEY TENCENT_FROM_EMAIL TENCENT_REGION; do
        value="$(env_value "$key")"
        is_placeholder "$value" && { printf "  - %s 未配置或仍是占位值\n" "$key" >&2; missing=1; }
      done
      ;;
    *)
      printf "  - EMAIL_PROVIDER 必须是 aliyun 或 tencent\n" >&2
      missing=1
      ;;
  esac

  [[ "$(env_value STORAGE_PROVIDER)" == "s3" ]] || {
    printf "  - STORAGE_PROVIDER 必须设置为 s3\n" >&2
    missing=1
  }
  [[ "$(env_value JWT_SECRET)" != *test* ]] || {
    printf "  - JWT_SECRET 不得使用测试密钥\n" >&2
    missing=1
  }
  [[ "$(env_value JUDGE_DOCKER_SOCKET_GID)" =~ ^[0-9]+$ ]] || {
    printf "  - JUDGE_DOCKER_SOCKET_GID 必须是数字\n" >&2
    missing=1
  }
  [[ "$(env_value NOJ_VERSION)" != "latest" ]] || {
    printf "  - NOJ_VERSION 必须使用不可变 Release 标签，不得使用 latest\n" >&2
    missing=1
  }
  ((missing == 0)) || fail "生产配置校验失败"
}

check_judge_socket() {
  local socket_path="$(env_value JUDGE_DOCKER_SOCKET)"
  case "$socket_path" in
    /var/run/docker.sock|/run/docker.sock)
      fail "禁止将应用宿主机 Docker socket 挂载给 judge：$socket_path"
      ;;
  esac
  [[ -e "$socket_path" ]] ||
    fail "Judge 隔离 Docker socket 不存在：$socket_path"
  ok "Judge 使用独立 Docker socket"
}

check_port_value() {
  local port="$(env_value NGINX_PORT)"
  port="${port:-8080}"
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) ||
    fail "NGINX_PORT 必须是 1-65535 的端口号"
  if command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "NGINX_PORT=$port 已被其他进程监听；启动时可能发生端口冲突"
  fi
}

check_dependencies() {
  section "检查部署环境"
  command -v "$DOCKER_BIN" >/dev/null 2>&1 ||
    fail "找不到 Docker CLI：$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || fail "Docker daemon 未运行或当前用户无权限"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 不可用"
  [[ -f "$COMPOSE_FILE" ]] || fail "找不到生产 Compose 文件：$COMPOSE_FILE"
  ok "Docker daemon 与 Compose 可用"
}

check_configuration() {
  [[ -f "$ENV_FILE" ]] || fail "找不到生产配置：$ENV_FILE，请先执行 install"
  check_file_permissions
  check_required_values
  check_judge_socket
  check_port_value

  if ((DRY_RUN)); then
    ok "[dry-run] 跳过会输出 Compose 解析结果的命令"
  else
    "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet ||
      fail "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件"
  fi
  ok "生产配置检查通过"
}

run_compose() {
  if ((DRY_RUN)); then
    printf "[dry-run] docker compose --env-file %s -f %s" "$ENV_FILE" "$COMPOSE_FILE"
    printf " %s" "$@"
    printf "\n"
    return 0
  fi
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

wait_for_stack() {
  section "等待服务健康"
  if ((DRY_RUN)); then
    ok "[dry-run] 将等待 Compose healthcheck 完成"
    return 0
  fi
  run_compose up -d --wait --wait-timeout 180 --remove-orphans ||
    fail "服务启动或健康检查失败，请执行 status 和 logs 排查"
  ok "生产服务已通过 Compose 健康检查"
}

prepare_and_check() {
  check_dependencies
  check_configuration
}

install() {
  initialize_env
  prepare_and_check
  section "拉取生产镜像"
  run_compose pull
  wait_for_stack
  ok "生产部署完成"
}

start() {
  prepare_and_check
  wait_for_stack
  ok "生产服务已启动"
}

upgrade() {
  prepare_and_check
  section "拉取目标版本镜像"
  run_compose pull
  wait_for_stack
  ok "生产服务已升级"
}

stop() {
  prepare_and_check
  section "停止生产服务"
  run_compose stop
  ok "服务已停止，数据卷已保留"
}

status() {
  prepare_and_check
  run_compose ps
}

logs() {
  prepare_and_check
  local args=(logs --tail=200)
  if ((FOLLOW)); then args+=(--follow); fi
  if ((${#POSITIONAL[@]} > 0)); then args+=("${POSITIONAL[@]}"); fi
  run_compose "${args[@]}"
}

backup() {
  prepare_and_check
  local pg_user pg_db timestamp target index
  pg_user="$(env_value POSTGRES_USER)"
  pg_db="$(env_value POSTGRES_DB)"
  pg_user="${pg_user:-noj}"
  pg_db="${pg_db:-noj}"
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  target="$BACKUP_DIR/postgres-$timestamp.dump"
  index=1
  while [[ -e "$target" ]]; do
    target="$BACKUP_DIR/postgres-$timestamp-$index.dump"
    index=$((index + 1))
  done

  if ((DRY_RUN)); then
    ok "[dry-run] 将创建 PostgreSQL 备份：$target"
    return 0
  fi

  umask 077
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  if ! "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
    exec -T postgres pg_dump -U "$pg_user" -d "$pg_db" -Fc >"$target"; then
    rm -f "$target"
    fail "PostgreSQL 备份失败；已有备份未被修改"
  fi
  chmod 600 "$target"
  ok "PostgreSQL 备份已创建：$target"
  warn "该备份不包含 Redis、MinIO 和环境文件；完整灾备请参照 #326"
}

main() {
  parse_args "$@"
  case "$COMMAND" in
    install) install ;;
    start) start ;;
    upgrade) upgrade ;;
    stop) stop ;;
    status) status ;;
    logs) logs ;;
    backup) backup ;;
    *) fail "未知命令：$COMMAND" ;;
  esac
}

main "$@"
