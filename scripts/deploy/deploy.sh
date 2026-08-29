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
#   bash scripts/deploy/deploy.sh verify
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
BACKUP_PASSPHRASE_FILE="${NOJ_BACKUP_PASSPHRASE_FILE:-}"
DOCKER_BIN="${NOJ_DEPLOY_DOCKER_BIN:-docker}"
PANEL_MODE="${NOJ_DEPLOY_PANEL:-auto}"
PANEL_NAME="none"
PANEL_ROOT="${NOJ_DEPLOY_PANEL_ROOT:-/www/server/panel}"
PANEL_COMMAND="${NOJ_DEPLOY_PANEL_COMMAND:-/usr/bin/bt}"
TTY_PATH="${NOJ_DEPLOY_TTY_PATH:-/dev/tty}"
DRY_RUN=0
FOLLOW=0
INTERACTIVE=1
[[ "${NOJ_DEPLOY_NON_INTERACTIVE:-0}" == "1" ]] && INTERACTIVE=0
declare -a VERIFIED_IMAGE_DIGESTS=()

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

has_interactive_tty() {
  [[ -r "$TTY_PATH" && -w "$TTY_PATH" ]] || return 1
  (exec 3<>"$TTY_PATH") 2>/dev/null
}

read_prompt() {
  local prompt="$1" secret="${2:-0}" value
  if has_interactive_tty; then
    printf '%s' "$prompt" >"$TTY_PATH"
    if [[ "$secret" == 1 ]]; then
      IFS= read -r -s value <"$TTY_PATH" || fail "读取配置输入失败"
      printf '\n' >"$TTY_PATH"
    else
      IFS= read -r value <"$TTY_PATH" || fail "读取配置输入失败"
    fi
  elif [[ "$secret" == 1 ]]; then
    IFS= read -r -s -p "$prompt" value || fail "读取配置输入失败"
    printf '\n' >&2
  else
    IFS= read -r -p "$prompt" value || fail "读取配置输入失败"
  fi
  PROMPT_VALUE="$value"
}

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
  deploy.sh backup                   创建完整生产备份
  deploy.sh verify                   校验生产镜像 digest 与 Cosign 签名

选项：
  --env-file FILE       使用指定的生产环境文件
  --compose-file FILE   使用指定的 Compose 文件
  --backup-dir DIR      指定备份目录（默认 ./backups）
  --passphrase-file FILE
                        GPG 备份口令文件（默认读取 NOJ_BACKUP_PASSPHRASE_FILE）
  --panel MODE           面板模式：auto（默认）、baota 或 none
  --dry-run             只检查并显示将执行的操作，不修改服务或文件
  --non-interactive     首次初始化不询问，配置不完整时直接失败
  -h, --help            显示帮助

环境变量：
  NOJ_DEPLOY_DOCKER_BIN  仅用于测试，指定 Docker CLI 路径
  NOJ_DEPLOY_PANEL       面板模式（默认 auto）
EOF
}

parse_args() {
  COMMAND=""
  POSITIONAL=()
  while (($# > 0)); do
    case "$1" in
      install|start|upgrade|stop|status|logs|backup|verify)
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
      --passphrase-file)
        (($# >= 2)) || fail "--passphrase-file 需要一个文件路径"
        BACKUP_PASSPHRASE_FILE="$2"
        shift
        ;;
      --passphrase-file=*) BACKUP_PASSPHRASE_FILE="${1#*=}" ;;
      --panel)
        (($# >= 2)) || fail "--panel 需要 auto、baota 或 none"
        PANEL_MODE="$2"
        shift
        ;;
      --panel=*) PANEL_MODE="${1#*=}" ;;
      --follow|-f) FOLLOW=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --non-interactive) INTERACTIVE=0 ;;
      -h|--help) usage; exit 0 ;;
      --) shift; POSITIONAL+=("$@"); break ;;
      *) POSITIONAL+=("$1") ;;
    esac
    shift
  done
  [[ -n "$COMMAND" ]] || { usage; exit 2; }
  case "$PANEL_MODE" in
    auto|baota|none) ;;
    *) fail "--panel 只能是 auto、baota 或 none：$PANEL_MODE" ;;
  esac
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

prompt_text() {
  local label="$1" default_value="${2:-}" value
  while :; do
    if [[ -n "$default_value" ]]; then
      read_prompt "$label [$default_value]: "
      value="$PROMPT_VALUE"
      value="${value:-$default_value}"
    else
      read_prompt "$label: "
      value="$PROMPT_VALUE"
    fi
    if [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]]; then
      PROMPT_VALUE="$value"
      return 0
    fi
    warn "该配置不能为空，请重新输入"
  done
}

prompt_secret() {
  local label="$1" value
  while :; do
    read_prompt "$label: " 1
    value="$PROMPT_VALUE"
    if [[ -n "$value" ]]; then
      PROMPT_VALUE="$value"
      return 0
    fi
    warn "该配置不能为空，请重新输入"
  done
}

prompt_password() {
  local label="$1" value confirmation
  while :; do
    read_prompt "$label（至少 12 位）: " 1
    value="$PROMPT_VALUE"
    read_prompt "再次输入以确认：" 1
    confirmation="$PROMPT_VALUE"
    if [[ -z "$value" ]]; then
      warn "管理员密码不能为空，请重新输入"
    elif (( ${#value} < 12 )); then
      warn "管理员密码至少需要 12 位，请重新输入"
    elif [[ "$value" != "$confirmation" ]]; then
      warn "两次输入的管理员密码不一致，请重新输入"
    else
      PROMPT_VALUE="$value"
      return 0
    fi
  done
}

current_config_value() {
  local key="$1" value
  value="$(env_value "$key")"
  if is_placeholder "$value"; then
    value=""
  fi
  printf '%s\n' "$value"
}

configuration_needs_interactive_input() {
  local key value
  for key in NOJ_VERSION DOMAIN APP_URL ADMIN_EMAIL ADMIN_PASS EMAIL_PROVIDER JUDGE_DOCKER_SOCKET; do
    value="$(current_config_value "$key")"
    is_placeholder "$value" && return 0
  done
  case "$(env_value EMAIL_PROVIDER)" in
    aliyun)
      for key in ALIBABA_ACCESS_KEY_ID ALIBABA_ACCESS_KEY_SECRET ALIBABA_FROM_EMAIL; do
        value="$(current_config_value "$key")"
        is_placeholder "$value" && return 0
      done
      ;;
    tencent)
      for key in TENCENT_SECRET_ID TENCENT_SECRET_KEY TENCENT_FROM_EMAIL TENCENT_REGION; do
        value="$(current_config_value "$key")"
        is_placeholder "$value" && return 0
      done
      ;;
  esac
  return 1
}

configure_env_interactive() {
  local version domain app_url admin_email email_provider socket_path socket_gid
  local current_value default_url

  section "填写生产配置"
  cat <<'EOF'
首次部署需要填写以下配置。输入过程中密码和云厂商密钥不会回显，脚本也不会打印这些敏感值。
其中 NOJ_VERSION 必须是已经发布的不可变版本标签；Judge Docker socket 必须是独立的 rootless Docker socket，不能填写 /var/run/docker.sock。
EOF

  current_value="$(current_config_value NOJ_VERSION)"
  prompt_text "NOJ_VERSION（例如 v0.1.0）" "$current_value"
  version="$PROMPT_VALUE"
  set_env_value NOJ_VERSION "$version"

  current_value="$(current_config_value DOMAIN)"
  prompt_text "DOMAIN（不含协议，例如 oj.example.com）" "$current_value"
  domain="$PROMPT_VALUE"
  [[ "$domain" != *[[:space:]]* && "$domain" != */* && "$domain" != *://* ]] ||
    fail "DOMAIN 不能包含协议、斜杠或空格"
  set_env_value DOMAIN "$domain"

  current_value="$(current_config_value APP_URL)"
  default_url="${current_value:-https://$domain}"
  prompt_text "APP_URL（完整地址）" "$default_url"
  app_url="$PROMPT_VALUE"
  [[ "$app_url" =~ ^https?://[^[:space:]]+$ ]] ||
    fail "APP_URL 必须是 http:// 或 https:// 开头的完整地址"
  set_env_value APP_URL "$app_url"
  set_env_value CORS_ALLOWED_ORIGINS "$app_url"

  current_value="$(current_config_value ADMIN_EMAIL)"
  prompt_text "管理员邮箱" "$current_value"
  admin_email="$PROMPT_VALUE"
  [[ "$admin_email" == *@*.* ]] || fail "管理员邮箱格式不正确"
  set_env_value ADMIN_EMAIL "$admin_email"
  prompt_password "管理员密码"
  set_env_value ADMIN_PASS "$PROMPT_VALUE"

  current_value="$(current_config_value EMAIL_PROVIDER)"
  while :; do
    prompt_text "邮件 Provider（aliyun 或 tencent）" "${current_value:-aliyun}"
    email_provider="$PROMPT_VALUE"
    case "$email_provider" in
      aliyun|tencent) break ;;
      *) warn "邮件 Provider 只能是 aliyun 或 tencent" ;;
    esac
  done
  set_env_value EMAIL_PROVIDER "$email_provider"
  if [[ "$email_provider" == aliyun ]]; then
    prompt_secret "阿里云 Access Key ID"
    set_env_value ALIBABA_ACCESS_KEY_ID "$PROMPT_VALUE"
    prompt_secret "阿里云 Access Key Secret"
    set_env_value ALIBABA_ACCESS_KEY_SECRET "$PROMPT_VALUE"
    current_value="$(current_config_value ALIBABA_FROM_EMAIL)"
    prompt_text "阿里云发件邮箱" "$current_value"
    set_env_value ALIBABA_FROM_EMAIL "$PROMPT_VALUE"
  else
    prompt_secret "腾讯云 Secret ID"
    set_env_value TENCENT_SECRET_ID "$PROMPT_VALUE"
    prompt_secret "腾讯云 Secret Key"
    set_env_value TENCENT_SECRET_KEY "$PROMPT_VALUE"
    current_value="$(current_config_value TENCENT_FROM_EMAIL)"
    prompt_text "腾讯云发件邮箱" "$current_value"
    set_env_value TENCENT_FROM_EMAIL "$PROMPT_VALUE"
    current_value="$(current_config_value TENCENT_REGION)"
    prompt_text "腾讯云 Region" "${current_value:-ap-guangzhou}"
    set_env_value TENCENT_REGION "$PROMPT_VALUE"
  fi

  current_value="$(current_config_value JUDGE_DOCKER_SOCKET)"
  prompt_text "Judge Docker socket（不能是 /var/run/docker.sock）" \
    "${current_value:-/run/noj-judge/docker.sock}"
  socket_path="$PROMPT_VALUE"
  set_env_value JUDGE_DOCKER_SOCKET "$socket_path"
  if [[ -e "$socket_path" ]]; then
    socket_gid="$(stat -c '%g' "$socket_path" 2>/dev/null || stat -f '%g' "$socket_path" 2>/dev/null || printf '10001')"
  else
    socket_gid="10001"
  fi
  current_value="$(current_config_value JUDGE_DOCKER_SOCKET_GID)"
  prompt_text "Judge Docker socket GID" "${current_value:-$socket_gid}"
  [[ "$PROMPT_VALUE" =~ ^[0-9]+$ ]] || fail "Judge Docker socket GID 必须是数字"
  set_env_value JUDGE_DOCKER_SOCKET_GID "$PROMPT_VALUE"
  ok "生产配置引导完成，正在继续校验和启动服务"
}

initialize_env() {
  section "初始化生产配置"
  [[ -f "$ENV_TEMPLATE" ]] || fail "找不到生产配置模板：$ENV_TEMPLATE"
  if [[ -e "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || fail "生产配置路径不是普通文件：$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "保留已有配置：$ENV_FILE"
    if ((INTERACTIVE)) && has_interactive_tty && configuration_needs_interactive_input; then
      configure_env_interactive
    fi
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
  if ((INTERACTIVE)) && has_interactive_tty; then
    configure_env_interactive
    return 0
  fi
  warn "当前没有可交互终端，无法引导填写生产配置"
  warn "请编辑 $ENV_FILE，填写 NOJ_VERSION、DOMAIN、APP_URL、邮件 Provider、管理员账号和 Judge Docker socket"
  warn "填写完成后重新执行：bash scripts/deploy/deploy.sh install"
  warn "自动化场景可显式使用 --non-interactive，让未完成配置直接失败"
  exit 2
}

check_file_permissions() {
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
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
  local version="$(env_value NOJ_VERSION)"
  [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
    printf "  - NOJ_VERSION 必须是不可变 Release 标签（如 v0.1.0 或 0.1.1-rc.1）\n" >&2
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

detect_panel() {
  PANEL_NAME="none"
  case "$PANEL_MODE" in
    baota) PANEL_NAME="baota" ;;
    none) return 0 ;;
    auto)
      if [[ -d "$PANEL_ROOT" || -x "$PANEL_COMMAND" ]]; then
        PANEL_NAME="baota"
      fi
      ;;
  esac
}

show_panel_guidance() {
  [[ "$PANEL_NAME" == baota ]] || return 0
  section "宝塔兼容模式"
  cat <<'EOF'
已检测到宝塔面板。脚本会直接使用宝塔管理的标准 Docker/Compose，不调用宝塔 API。

前后端 Compose 自带 Nginx。请在宝塔的网站/反向代理中把域名转发到
127.0.0.1:NGINX_PORT，默认端口为 8080；如果修改了 .env.prod 中的 NGINX_PORT，
请使用修改后的端口。请先确认该端口没有被宝塔已有网站或其他服务占用。

脚本不会修改已有站点、证书、反向代理、容器或面板配置。Judge 仍必须使用只服务于
Judge 的 rootless Docker socket，不能填写 /run/docker.sock 或 /var/run/docker.sock。
EOF
  ok "宝塔兼容提示已启用"
}

check_dependencies() {
  section "检查部署环境"
  detect_panel
  show_panel_guidance
  command -v "$DOCKER_BIN" >/dev/null 2>&1 ||
    fail "找不到 Docker CLI：$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || fail "Docker daemon 未运行或当前用户无权限"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 不可用"
  if [[ "$(env_value NOJ_ENFORCE_IMAGE_SIGNATURES)" != "false" ]]; then
    "$DOCKER_BIN" buildx version >/dev/null 2>&1 ||
      fail "镜像签名校验需要 Docker Buildx"
  fi
  [[ -f "$COMPOSE_FILE" ]] || fail "找不到生产 Compose 文件：$COMPOSE_FILE"
  ok "Docker daemon 与 Compose 可用"
}

verify_image_signatures() {
  [[ "$(env_value NOJ_ENFORCE_IMAGE_SIGNATURES)" != "false" ]] || {
    warn "NOJ_ENFORCE_IMAGE_SIGNATURES=false，跳过生产镜像签名校验（仅适用于本地测试）"
    return 0
  }

  command -v cosign >/dev/null 2>&1 ||
    fail "生产镜像签名校验需要 cosign；请先安装 Cosign，或仅在本地测试中设置 NOJ_ENFORCE_IMAGE_SIGNATURES=false"

  local version registry identity image digest
  version="$(env_value NOJ_VERSION)"
  registry="$(env_value NOJ_IMAGE_REGISTRY)"
  registry="${registry:-ghcr.io/neuro-oj}"
  identity="$(env_value NOJ_COSIGN_CERT_IDENTITY_REGEX)"
  identity="${identity:-^https://github.com/Neuro-OJ/neuro-oj/.github/workflows/release.yml@.*$}"
  section "校验生产镜像签名"

  local images=(noj-core noj-ui noj-judge noj-llm-gateway noj-evaluator-python noj-solution-python)
  for image in "${images[@]}"; do
    local image_name="$image"
    image="$registry/$image_name:$version"
    digest="$("$DOCKER_BIN" buildx imagetools inspect "$image" 2>/dev/null |
      awk '/^Digest:/ {print $2; exit}')"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      fail "无法解析生产镜像 digest：$image"
    cosign verify \
      --certificate-identity-regexp "$identity" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$image@$digest" >/dev/null ||
      fail "生产镜像 Cosign 签名校验失败：$image@$digest"
    VERIFIED_IMAGE_DIGESTS+=("$image_name $digest")
    ok "$image@$digest"
  done
}

record_deployment_metadata() {
  ((DRY_RUN)) && return 0
  ((${#VERIFIED_IMAGE_DIGESTS[@]} > 0)) || return 0

  mkdir -p "$BACKUP_DIR"
  local tmp manifest
  manifest="$BACKUP_DIR/current-deployment.txt"
  tmp="$(mktemp "$BACKUP_DIR/.current-deployment.XXXXXX")"
  {
    printf 'version=%s\n' "$(env_value NOJ_VERSION)"
    printf 'recorded_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '%s\n' "${VERIFIED_IMAGE_DIGESTS[@]}" | sort
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$manifest"
  ok "已记录当前部署版本与镜像 digest：$manifest"
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
  case "$COMMAND" in
    install|start|upgrade|verify) verify_image_signatures ;;
  esac
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
  check_dependencies
  initialize_env
  check_configuration
  section "拉取生产镜像"
  run_compose pull
  wait_for_stack
  record_deployment_metadata
  ok "生产部署完成"
}

start() {
  prepare_and_check
  wait_for_stack
  record_deployment_metadata
  ok "生产服务已启动"
}

upgrade() {
  prepare_and_check
  run_backup "upgrade"
  section "拉取目标版本镜像"
  run_compose pull
  wait_for_stack
  record_deployment_metadata
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

run_backup() {
  local reason="${1:-manual}"
  if ((DRY_RUN)); then
    ok "[dry-run] 将在${reason}流程中创建并校验完整生产备份"
    return 0
  fi
  local args=(create --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" --backup-dir "$BACKUP_DIR")
  [[ -n "$BACKUP_PASSPHRASE_FILE" ]] && args+=(--passphrase-file "$BACKUP_PASSPHRASE_FILE")
  NOJ_BACKUP_DOCKER_BIN="$DOCKER_BIN" bash "$SCRIPT_DIR/backup.sh" "${args[@]}"
}

backup() {
  prepare_and_check
  run_backup "手动备份"
}

verify() {
  prepare_and_check
  ok "生产镜像验证完成"
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
    verify) verify ;;
    *) fail "未知命令：$COMMAND" ;;
  esac
}

main "$@"
