#!/usr/bin/env bash
#
# Neuro OJ 生产部署入口。
#
# 用法：
#   bash scripts/deploy/deploy.sh install
#   bash scripts/deploy/deploy.sh start
#   bash scripts/deploy/deploy.sh upgrade
#   bash scripts/deploy/deploy.sh stop
#   bash scripts/deploy/deploy.sh uninstall --yes
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
DEFAULT_BACKUP_PASSPHRASE_FILE="/etc/noj/backup-passphrase"
DOCKER_BIN="${NOJ_DEPLOY_DOCKER_BIN:-docker}"
PANEL_MODE="${NOJ_DEPLOY_PANEL:-auto}"
PANEL_NAME="none"
PANEL_ROOT="${NOJ_DEPLOY_PANEL_ROOT:-/www/server/panel}"
PANEL_COMMAND="${NOJ_DEPLOY_PANEL_COMMAND:-/usr/bin/bt}"
TTY_PATH="${NOJ_DEPLOY_TTY_PATH:-/dev/tty}"
DRY_RUN=0
FOLLOW=0
INTERACTIVE=1
UNINSTALL_CONFIRMED=0
UNINSTALL_ALL=0
INCLUDE_ALL_PROFILES=0
[[ "${NOJ_DEPLOY_NON_INTERACTIVE:-0}" == "1" ]] && INTERACTIVE=0
declare -a VERIFIED_IMAGE_DIGESTS=()
CONFIG_STAGE_FILE=""
CONFIG_TARGET_FILE=""

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
  deploy.sh uninstall [--yes]       删除容器、网络和本地镜像（保留数据卷）
  deploy.sh uninstall --all --yes   删除 NOJ 栈及全部数据（不可恢复）
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
  --yes, -y             仅用于 uninstall，跳过明确确认提示
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
      install|start|upgrade|stop|uninstall|status|logs|backup|verify)
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
      --yes|-y) UNINSTALL_CONFIRMED=1 ;;
      --all) UNINSTALL_ALL=1 ;;
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

is_exit_word() {
  case "$1" in
    exit|EXIT|quit|QUIT|cancel|CANCEL|q|Q|取消) return 0 ;;
    *) return 1 ;;
  esac
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

prompt_yes_no() {
  local label="$1" default="${2:-y}" answer
  while :; do
    if [[ "$default" == y ]]; then
      read_prompt "$label [Y/n]: "
    else
      read_prompt "$label [y/N]: "
    fi
    answer="${PROMPT_VALUE:-$default}"
    case "$answer" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) warn "请输入 Y 或 N" ;;
    esac
  done
}

current_config_value() {
  local key="$1" value
  value="$(env_value "$key")"
  if is_placeholder "$value"; then
    value=""
  fi
  if [[ "$key" == DOMAIN ]] && is_exit_word "$value"; then
    value=""
  fi
  printf '%s\n' "$value"
}

config_prompt_value() {
  local key="$1" reset_existing="${2:-0}"
  if ((reset_existing)); then
    return 0
  fi
  current_config_value "$key"
}

cleanup_config_staging() {
  if [[ -n "$CONFIG_STAGE_FILE" && -f "$CONFIG_STAGE_FILE" ]]; then
    rm -f "$CONFIG_STAGE_FILE"
  fi
  if [[ -n "$CONFIG_TARGET_FILE" ]]; then
    ENV_FILE="$CONFIG_TARGET_FILE"
  fi
  CONFIG_STAGE_FILE=""
  CONFIG_TARGET_FILE=""
}

trap cleanup_config_staging EXIT

begin_config_staging() {
  [[ -f "$ENV_FILE" ]] || fail "找不到用于暂存的生产配置：$ENV_FILE"
  CONFIG_TARGET_FILE="$ENV_FILE"
  CONFIG_STAGE_FILE="$(mktemp "${ENV_FILE}.staging.XXXXXX")" ||
    fail "无法创建临时配置文件"
  if ! cp "$CONFIG_TARGET_FILE" "$CONFIG_STAGE_FILE"; then
    cleanup_config_staging
    fail "无法复制生产配置到临时文件"
  fi
  chmod 600 "$CONFIG_STAGE_FILE"
  ENV_FILE="$CONFIG_STAGE_FILE"
}

commit_config_staging() {
  local staged_file="$CONFIG_STAGE_FILE" target_file="$CONFIG_TARGET_FILE"
  [[ -n "$staged_file" && -n "$target_file" && -f "$staged_file" ]] ||
    fail "找不到待写入的临时配置"
  chmod 600 "$staged_file"
  mv "$staged_file" "$target_file" || fail "写入生产配置失败"
  ENV_FILE="$target_file"
  CONFIG_STAGE_FILE=""
  CONFIG_TARGET_FILE=""
}

cancel_config_staging() {
  cleanup_config_staging
}

email_provider_prompt_label() {
  case "$1" in
    aliyun) printf '邮件服务（当前已配置阿里云；回车继续使用，输入 skip 暂不配置）\n' ;;
    tencent) printf '邮件服务（当前已配置腾讯云；回车继续使用，输入 skip 暂不配置）\n' ;;
    *) printf '邮件服务（可选阿里云/腾讯云；直接回车暂不配置）\n' ;;
  esac
}

is_ipv4_address() {
  local address="$1" octet
  local -a octets=()
  [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -r -a octets <<<"$address"
  for octet in "${octets[@]}"; do
    ((10#$octet <= 255)) || return 1
  done
}

is_site_address() {
  local address="$1"
  if is_ipv4_address "$address"; then
    return 0
  fi
  [[ "$address" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] &&
    [[ "$address" == *.* ]]
}

detect_default_ipv4() {
  local candidate route_info
  candidate="${NOJ_DEPLOY_DEFAULT_IP:-}"
  if is_ipv4_address "$candidate" && [[ "$candidate" != 127.* ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    route_info="$(ip -4 route get 1.1.1.1 2>/dev/null || true)"
    candidate="$(awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }' <<<"$route_info")"
    if is_ipv4_address "$candidate" && [[ "$candidate" != 127.* ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    while IFS= read -r candidate; do
      if is_ipv4_address "$candidate" && [[ "$candidate" != 127.* ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(hostname -I 2>/dev/null | tr ' ' '\n')
  fi
}

configuration_needs_interactive_input() {
  local key value
  for key in NOJ_VERSION DOMAIN APP_URL EMAIL_PROVIDER JUDGE_ENABLED; do
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
  if judge_enabled; then
    for key in JUDGE_DOCKER_SOCKET JUDGE_DOCKER_SOCKET_GID; do
      value="$(current_config_value "$key")"
      is_placeholder "$value" && return 0
    done
  fi
  return 1
}

confirm_reuse_config() {
  printf '检测到先前生产配置：%s\n' "$ENV_FILE"
  if prompt_yes_no '是否使用先前配置？（Y=保留，N=重新填写）' y; then
    ok "将使用先前配置"
    return 0
  fi
  warn "将进入配置向导重新填写"
  return 1
}

configure_env_interactive() {
  local version domain app_url email_provider socket_path socket_gid key
  local judge_default judge_install
  local current_value current_app_url detected_ip default_domain ssl_default email_prompt_label
  local email_provider_reused=0
  local reset_existing="${1:-0}"

  begin_config_staging
  section "填写生产配置"
  cat <<'EOF'
请按提示填写网站和服务配置。邮件密钥不会显示在屏幕上，也不会被脚本打印。
“网站地址”是域名或服务器 IP；脚本会根据 HTTPS 选择自动生成浏览器访问地址。
评测服务连接位置一般保持默认即可；邮件服务可以选择“暂不配置”，以后再补充。
如果暂时没有独立的评测 Docker 服务，可以选择跳过 Judge，网站和题库仍可先部署。
安装完成后请立即打开网站注册第一个用户；第一个注册用户会自动获得管理员权限。
EOF

  current_value="$(config_prompt_value NOJ_VERSION "$reset_existing")"
  prompt_text "安装版本（例如 v0.8.0-rc.1）" "$current_value"
  version="$PROMPT_VALUE"
  set_env_value NOJ_VERSION "$version"

  current_value="$(config_prompt_value DOMAIN "$reset_existing")"
  detected_ip="$(detect_default_ipv4)"
  default_domain="${current_value:-$detected_ip}"
  prompt_text "网站地址（域名或服务器 IP，不要写 https://；可直接回车使用检测到的 IP）" "$default_domain"
  domain="$PROMPT_VALUE"
  is_site_address "$domain" ||
    fail "网站地址必须是域名或服务器 IP，例如 oj.example.com 或 192.0.2.10"
  set_env_value DOMAIN "$domain"
  if is_ipv4_address "$domain"; then
    warn "当前使用服务器 IP；正式环境仍需 HTTPS，建议以后换成域名并配置证书"
  fi

  current_app_url="$(config_prompt_value APP_URL "$reset_existing")"
  if [[ "$current_app_url" == http://* ]]; then
    ssl_default=n
  else
    ssl_default=y
  fi
  if prompt_yes_no '是否使用 HTTPS（证书需在宝塔或反向代理中配置）' "$ssl_default"; then
    set_env_value NOJ_ALLOW_INSECURE_HTTP "false"
    app_url="https://$domain"
  else
    set_env_value NOJ_ALLOW_INSECURE_HTTP "true"
    app_url="http://$domain"
    warn "已选择临时 HTTP；登录信息可能被窃取，正式使用前请配置 HTTPS"
  fi
  set_env_value APP_URL "$app_url"
  set_env_value CORS_ALLOWED_ORIGINS "$app_url"

  current_value="$(config_prompt_value EMAIL_PROVIDER "$reset_existing")"
  while :; do
    email_prompt_label="$(email_provider_prompt_label "$current_value")"
    prompt_text "$email_prompt_label" "${current_value:-disabled}"
    email_provider="$PROMPT_VALUE"
    case "$email_provider" in
      aliyun|tencent) break ;;
      disabled|skip|none|跳过|暂不配置) email_provider=disabled; break ;;
      *) warn "请输入 aliyun、tencent，或选择暂不配置" ;;
    esac
  done
  if [[ "$reset_existing" != 1 && "$current_value" == "$email_provider" ]] &&
    [[ "$email_provider" == aliyun || "$email_provider" == tencent ]]; then
    email_provider_reused=1
  fi
  set_env_value EMAIL_PROVIDER "$email_provider"
  if [[ "$email_provider" == aliyun ]]; then
    if ((email_provider_reused)) && [[ -n "$(current_config_value ALIBABA_ACCESS_KEY_ID)" ]] &&
      ! is_placeholder "$(current_config_value ALIBABA_ACCESS_KEY_ID)"; then
      :
    else
      prompt_secret "阿里云 Access Key ID"
      set_env_value ALIBABA_ACCESS_KEY_ID "$PROMPT_VALUE"
    fi
    if ((email_provider_reused)) && [[ -n "$(current_config_value ALIBABA_ACCESS_KEY_SECRET)" ]] &&
      ! is_placeholder "$(current_config_value ALIBABA_ACCESS_KEY_SECRET)"; then
      :
    else
      prompt_secret "阿里云 Access Key Secret"
      set_env_value ALIBABA_ACCESS_KEY_SECRET "$PROMPT_VALUE"
    fi
    current_value="$(config_prompt_value ALIBABA_FROM_EMAIL "$reset_existing")"
    if ((email_provider_reused)) && [[ -n "$current_value" ]] && ! is_placeholder "$current_value"; then
      :
    else
      prompt_text "阿里云发件邮箱" "$current_value"
      set_env_value ALIBABA_FROM_EMAIL "$PROMPT_VALUE"
    fi
  elif [[ "$email_provider" == tencent ]]; then
    if ((email_provider_reused)) && [[ -n "$(current_config_value TENCENT_SECRET_ID)" ]] &&
      ! is_placeholder "$(current_config_value TENCENT_SECRET_ID)"; then
      :
    else
      prompt_secret "腾讯云 Secret ID"
      set_env_value TENCENT_SECRET_ID "$PROMPT_VALUE"
    fi
    if ((email_provider_reused)) && [[ -n "$(current_config_value TENCENT_SECRET_KEY)" ]] &&
      ! is_placeholder "$(current_config_value TENCENT_SECRET_KEY)"; then
      :
    else
      prompt_secret "腾讯云 Secret Key"
      set_env_value TENCENT_SECRET_KEY "$PROMPT_VALUE"
    fi
    current_value="$(config_prompt_value TENCENT_FROM_EMAIL "$reset_existing")"
    if ((email_provider_reused)) && [[ -n "$current_value" ]] && ! is_placeholder "$current_value"; then
      :
    else
      prompt_text "腾讯云发件邮箱" "$current_value"
      set_env_value TENCENT_FROM_EMAIL "$PROMPT_VALUE"
    fi
    current_value="$(config_prompt_value TENCENT_REGION "$reset_existing")"
    if ((email_provider_reused)) && [[ -n "$current_value" ]] && ! is_placeholder "$current_value"; then
      :
    else
      prompt_text "腾讯云 Region" "${current_value:-ap-guangzhou}"
      set_env_value TENCENT_REGION "$PROMPT_VALUE"
    fi
  else
    for key in ALIBABA_ACCESS_KEY_ID ALIBABA_ACCESS_KEY_SECRET ALIBABA_FROM_EMAIL \
      TENCENT_SECRET_ID TENCENT_SECRET_KEY TENCENT_FROM_EMAIL TENCENT_REGION; do
      set_env_value "$key" ""
    done
    warn "已跳过邮件服务；密码找回邮件暂时不可用，可稍后在后台配置"
  fi

  current_value="$(config_prompt_value JUDGE_ENABLED "$reset_existing")"
  case "$current_value" in
    false|FALSE|no|NO|0|off|OFF) judge_default=n ;;
    *) judge_default=y ;;
  esac
  if prompt_yes_no '是否安装评测服务 Judge（没有评测 Docker 服务也可以跳过）' "$judge_default"; then
    judge_install=true
  else
    judge_install=false
    warn "已跳过 Judge；当前部署暂时不能进行代码评测，准备好后可再次启用"
  fi
  set_env_value JUDGE_ENABLED "$judge_install"

  if [[ "$judge_install" == true ]]; then
    current_value="$(config_prompt_value JUDGE_DOCKER_SOCKET "$reset_existing")"
    prompt_text "评测服务连接位置（一般直接回车）" \
      "${current_value:-/run/noj-judge/docker.sock}"
    socket_path="$PROMPT_VALUE"
    set_env_value JUDGE_DOCKER_SOCKET "$socket_path"
    if [[ -e "$socket_path" ]]; then
      socket_gid="$(stat -c '%g' "$socket_path" 2>/dev/null || stat -f '%g' "$socket_path" 2>/dev/null || printf '10001')"
    else
      socket_gid="10001"
    fi
    current_value="$(config_prompt_value JUDGE_DOCKER_SOCKET_GID "$reset_existing")"
    prompt_text "评测服务连接编号（一般直接回车）" "${current_value:-$socket_gid}"
    [[ "$PROMPT_VALUE" =~ ^[0-9]+$ ]] || fail "Judge Docker socket GID 必须是数字"
    set_env_value JUDGE_DOCKER_SOCKET_GID "$PROMPT_VALUE"
  else
    ok "已跳过 Judge 配置"
  fi
  ok "配置已暂存，尚未写入正式配置"
  if prompt_yes_no '是否写入配置？（Y=写入并继续部署，N=取消）' y; then
    commit_config_staging
    ok "配置已写入，正在继续校验和启动服务"
  else
    cancel_config_staging
    warn "已取消本次部署，正式配置未修改"
    return 1
  fi
}

initialize_env() {
  section "初始化生产配置"
  [[ -f "$ENV_TEMPLATE" ]] || fail "找不到生产配置模板：$ENV_TEMPLATE"
  if [[ -e "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || fail "生产配置路径不是普通文件：$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "保留已有配置：$ENV_FILE"
    if ((INTERACTIVE)) && has_interactive_tty; then
      if confirm_reuse_config; then
        if configuration_needs_interactive_input; then
          warn "先前配置尚未填写完整，将进入补齐向导"
          configure_env_interactive || return 1
        fi
      else
        configure_env_interactive 1 || return 1
      fi
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
  if [[ -n "${NOJ_DEPLOY_DEFAULT_VERSION:-}" ]]; then
    set_env_value NOJ_VERSION "$NOJ_DEPLOY_DEFAULT_VERSION"
  fi
  set_env_value MINIO_ROOT_USER "nojminio$(openssl rand -hex 6)"
  set_env_value S3_ACCESS_KEY "nojs3$(openssl rand -hex 6)"

  ok "已创建并保护 $ENV_FILE"
  if ((INTERACTIVE)) && has_interactive_tty; then
        configure_env_interactive 1 || return 1
    return 0
  fi
  warn "当前没有可交互终端，无法引导填写生产配置"
  warn "请编辑 ${ENV_FILE}，填写安装版本、网站地址、HTTPS 选项、邮件服务和是否安装 Judge"
  warn "如果安装 Judge，还要填写评测服务连接位置"
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

judge_enabled() {
  case "$(env_value JUDGE_ENABLED)" in
    false|FALSE|no|NO|0|off|OFF) return 1 ;;
    ""|true|TRUE|yes|YES|1|on|ON) return 0 ;;
    *) fail "JUDGE_ENABLED 必须是 true 或 false" ;;
  esac
}

check_required_values() {
  local key value
  local required_keys=(
    NOJ_VERSION DOMAIN APP_URL CORS_ALLOWED_ORIGINS TRUSTED_PROXIES
    POSTGRES_PASSWORD REDIS_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD
    S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_ENDPOINT STORAGE_PROVIDER
    JWT_SECRET TFA_ENCRYPTION_KEY NOJ_LLM_SERVICE_TOKEN NOJ_LLM_STORE_KEY
    EMAIL_PROVIDER
  )
  local missing=0
  for key in "${required_keys[@]}"; do
    value="$(env_value "$key")"
    if is_placeholder "$value"; then
      printf "  - %s 未配置或仍是占位值\n" "$key" >&2
      missing=1
    fi
  done
  judge_enabled || true
  if judge_enabled; then
    for key in JUDGE_DOCKER_SOCKET JUDGE_DOCKER_SOCKET_GID; do
      value="$(env_value "$key")"
      if is_placeholder "$value"; then
        printf "  - %s 未配置或仍是占位值\n" "$key" >&2
        missing=1
      fi
    done
  fi
  ((missing == 0)) || fail "生产配置未完成，请先修复上面的配置项"

  is_site_address "$(env_value DOMAIN)" || {
    printf "  - 网站地址必须是域名或服务器 IP\n" >&2
    missing=1
  }

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
    disabled)
      ;;
    *)
      printf "  - EMAIL_PROVIDER 必须是 aliyun、tencent 或 disabled\n" >&2
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
  if judge_enabled && ! [[ "$(env_value JUDGE_DOCKER_SOCKET_GID)" =~ ^[0-9]+$ ]]; then
    printf "  - JUDGE_DOCKER_SOCKET_GID 必须是数字\n" >&2
    missing=1
  fi
  local app_url="$(env_value APP_URL)"
  if [[ "$app_url" == http://* && "$(env_value NOJ_ALLOW_INSECURE_HTTP)" != true ]]; then
    printf "  - 网站完整网址使用 HTTP 时，必须明确选择临时 HTTP 模式\n" >&2
    missing=1
  fi
  if [[ "$app_url" != http://* && "$app_url" != https://* ]]; then
    printf "  - 网站完整网址必须以 http:// 或 https:// 开头\n" >&2
    missing=1
  fi
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

脚本不会修改已有站点、证书、反向代理、容器或面板配置。如果安装 Judge，仍必须使用
只服务于 Judge 的 rootless Docker socket，不能填写 /run/docker.sock 或 /var/run/docker.sock。
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
    warn "NOJ_ENFORCE_IMAGE_SIGNATURES=false，已关闭镜像签名校验"
    return 0
  }

  command -v cosign >/dev/null 2>&1 ||
    fail "已开启镜像签名校验，但找不到 Cosign；请先安装 Cosign，或将 NOJ_ENFORCE_IMAGE_SIGNATURES 设置为 false"

  local version registry identity image digest
  version="$(env_value NOJ_VERSION)"
  registry="$(env_value NOJ_IMAGE_REGISTRY)"
  registry="${registry:-ghcr.io/neuro-oj}"
  identity="$(env_value NOJ_COSIGN_CERT_IDENTITY_REGEX)"
  identity="${identity:-^https://github.com/Neuro-OJ/neuro-oj/.github/workflows/release.yml@.*$}"
  section "校验生产镜像签名"

  local images=(noj-server noj-ui noj-llm-gateway)
  if judge_enabled; then
    images+=(noj-judge noj-evaluator-python noj-solution-python)
  fi
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
  [[ -f "$ENV_FILE" ]] || fail "找不到生产配置：${ENV_FILE}，请先执行 install"
  check_file_permissions
  check_required_values
  if judge_enabled; then
    check_judge_socket
  else
    ok "已跳过 Judge Docker socket 检查"
  fi
  check_port_value

  if ((DRY_RUN)); then
    ok "[dry-run] 跳过会输出 Compose 解析结果的命令"
  else
    run_compose config --quiet ||
      fail "Docker Compose 配置无效，请检查环境变量和生产 Compose 文件"
  fi
  case "$COMMAND" in
    install|start|upgrade|verify) verify_image_signatures ;;
  esac
  ok "生产配置检查通过"
}

passphrase_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

ensure_backup_passphrase() {
  local configured_file target_file parent temp mode
  ((DRY_RUN)) && return 0
  configured_file="$(env_value NOJ_BACKUP_PASSPHRASE_FILE)"
  target_file="${BACKUP_PASSPHRASE_FILE:-${configured_file:-$DEFAULT_BACKUP_PASSPHRASE_FILE}}"
  BACKUP_PASSPHRASE_FILE="$target_file"

  if [[ -e "$target_file" ]]; then
    [[ -f "$target_file" ]] || fail "GPG 备份口令路径不是普通文件：$target_file"
    mode="$(passphrase_file_mode "$target_file")"
    [[ "$mode" == 600 || "$mode" == 400 ]] ||
      fail "GPG 备份口令文件权限必须为 600 或 400：$target_file"
    return 0
  fi

  command -v openssl >/dev/null 2>&1 ||
    fail "无法自动创建 GPG 备份口令文件，请安装 openssl 或使用 --passphrase-file 指定已有文件"
  parent="$(dirname -- "$target_file")"
  mkdir -p -m 700 -- "$parent" ||
    fail "无法创建 GPG 备份口令目录：$parent；请使用 --passphrase-file 指定可写路径"
  temp="$(mktemp "$target_file.tmp.XXXXXX")" ||
    fail "无法创建 GPG 备份口令文件：$target_file"
  chmod 600 "$temp"
  if ! openssl rand -hex 32 >"$temp" || ! mv -- "$temp" "$target_file"; then
    rm -f -- "$temp"
    fail "无法创建 GPG 备份口令文件：$target_file"
  fi
  chmod 600 "$target_file"
  if [[ -z "$configured_file" && -z "${NOJ_BACKUP_PASSPHRASE_FILE:-}" ]]; then
    set_env_value NOJ_BACKUP_PASSPHRASE_FILE "$target_file"
  fi
  ok "已准备 GPG 备份口令文件：$target_file"
  warn "请将该口令文件安全复制到仓库外的异地位置，否则无法恢复加密快照"
}

run_compose() {
  local -a compose_args=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if ((INCLUDE_ALL_PROFILES)) || judge_enabled; then
    compose_args+=(--profile judge)
  fi
  if ((DRY_RUN)); then
    printf "[dry-run] docker compose --env-file %s -f %s" "$ENV_FILE" "$COMPOSE_FILE"
    if judge_enabled; then
      printf " --profile judge"
    fi
    printf " %s" "$@"
    printf "\n"
    return 0
  fi
  "$DOCKER_BIN" compose "${compose_args[@]}" "$@"
}

wait_for_stack() {
  section "等待服务健康"
  if ((DRY_RUN)); then
    ok "[dry-run] 将等待 Compose healthcheck 完成"
    return 0
  fi
  run_compose up -d --wait --wait-timeout 180 --remove-orphans ||
    fail "服务启动或健康检查失败，请执行 status 和 logs 排查"
  run_compose up -d --force-recreate --no-deps nginx ||
    fail "反向代理刷新失败，请执行 status 和 logs 排查"
  ok "生产服务已通过 Compose 健康检查"
}

prepare_and_check() {
  check_dependencies
  check_configuration
}

install() {
  check_dependencies
  initialize_env
  ensure_backup_passphrase
  check_configuration
  section "拉取生产镜像"
  run_compose pull
  wait_for_stack
  record_deployment_metadata
  ok "生产部署完成"
  cat <<'EOF'

下一步：打开网站并注册第一个用户。新站点的第一个注册用户会自动获得管理员权限；
请立即完成注册，避免其他人抢先注册。已有站点的用户权限不会因升级改变。
EOF
  if judge_enabled; then
    ok "评测服务 Judge 已安装并启动"
  else
    cat <<'EOF'

当前跳过了评测服务 Judge，网站暂时不能进行代码评测。
以后准备好独立的 Judge Docker 服务后，将 .env.prod 中的 JUDGE_ENABLED 改为 true，
补充 JUDGE_DOCKER_SOCKET 和 JUDGE_DOCKER_SOCKET_GID，再执行：
  bash scripts/deploy/deploy.sh start
EOF
  fi
}

start() {
  prepare_and_check
  wait_for_stack
  record_deployment_metadata
  ok "生产服务已启动"
}

upgrade() {
  prepare_and_check
  ensure_backup_passphrase
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

confirm_uninstall() {
  ((DRY_RUN)) && return 0
  if ((UNINSTALL_CONFIRMED)); then
    return 0
  fi
  has_interactive_tty ||
    fail "卸载需要交互确认；自动化环境请显式使用 --yes"
  if ((UNINSTALL_ALL)); then
    cat >&2 <<'EOF'
警告：即将完全删除 NOJ：
  - 删除当前 Compose 栈的容器、网络、本地镜像和全部数据卷
  - 删除当前安装目录中的配置、备份和部署文件
  - 删除指向当前安装目录的 PATH 命令软链接
  - 不修改宿主机 Nginx/Caddy/宝塔站点、证书或其他容器
此操作不可恢复，请先确认备份已经下载到其他位置。
EOF
    read_prompt '请输入 DELETE ALL 确认完全删除（其他输入取消）：'
    [[ "$PROMPT_VALUE" == 'DELETE ALL' ]] ||
      fail "未确认完全删除，未修改任何服务或文件"
  else
    cat >&2 <<'EOF'
即将卸载 NOJ 生产服务：
  - 删除当前 Compose 栈的容器、网络和本地镜像
  - 保留 PostgreSQL、Redis、MinIO、题目包和 Judge 缓存数据卷
  - 保留 .env.prod、备份和部署目录
  - 不修改宿主机 Nginx/Caddy/宝塔站点、证书或其他容器
EOF
    read_prompt '请输入 UNINSTALL 确认卸载（其他输入取消）：'
    [[ "$PROMPT_VALUE" == UNINSTALL ]] ||
      fail "未确认卸载，未修改任何服务或文件"
  fi
}

check_uninstall_dependencies() {
  section "检查卸载环境"
  command -v "$DOCKER_BIN" >/dev/null 2>&1 ||
    fail "找不到 Docker CLI：$DOCKER_BIN"
  "$DOCKER_BIN" info >/dev/null 2>&1 || fail "Docker daemon 未运行或当前用户无权限"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 不可用"
  [[ -f "$ENV_FILE" ]] || fail "找不到生产配置：$ENV_FILE；无法安全定位生产 Compose 栈"
  [[ -f "$COMPOSE_FILE" ]] || fail "找不到生产 Compose 文件：$COMPOSE_FILE"
  ok "Docker daemon、Compose 和卸载配置可用"
}

uninstall() {
  confirm_uninstall
  check_uninstall_dependencies
  section "卸载生产服务"
  INCLUDE_ALL_PROFILES=1
  if ((UNINSTALL_ALL)); then
    run_compose down --remove-orphans --rmi all --volumes
    ok "生产容器、网络、本地镜像和数据卷已清理"
  else
    run_compose down --remove-orphans --rmi local
    ok "生产容器、网络和 Compose 管理的本地镜像已清理"
    ok "数据卷、生产配置、备份和部署目录已保留"
  fi
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
  ensure_backup_passphrase
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
    uninstall) uninstall ;;
    status) status ;;
    logs) logs ;;
    backup) backup ;;
    verify) verify ;;
    *) fail "未知命令：$COMMAND" ;;
  esac
}

if [[ "${NOJ_DEPLOY_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
