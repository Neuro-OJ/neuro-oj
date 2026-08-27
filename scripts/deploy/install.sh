#!/usr/bin/env bash
#
# Neuro OJ 独立下载与生产部署入口。
#
# 此文件可以单独下载后执行，不依赖当前工作目录或本地 Git 仓库：
#   curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/scripts/deploy/install.sh \
#     -o noj-install.sh
#   bash noj-install.sh --ref v0.1.0 --dir /opt/neuro-oj
#
# Bootstrap 只负责获取源码；生产 Compose、配置校验和服务生命周期仍由
# 下载后的 scripts/deploy/deploy.sh 负责。

set -Eeuo pipefail

readonly DEFAULT_REPOSITORY="https://github.com/Neuro-OJ/neuro-oj"
readonly DEFAULT_REF="v0.1.0"

REPOSITORY="${NOJ_BOOTSTRAP_REPOSITORY:-$DEFAULT_REPOSITORY}"
REF="${NOJ_BOOTSTRAP_REF:-$DEFAULT_REF}"
TARGET_DIR="${NOJ_BOOTSTRAP_DIR:-/opt/neuro-oj}"
DOWNLOAD_ONLY=0
DRY_RUN=0
TEMP_ROOT=""
ARCHIVE_URL=""
ARCHIVE_ROOT=""
DEPLOY_ARGS=()
ARCHIVE_PATH=""

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

usage() {
  cat <<'EOF'
Neuro OJ Linux 独立下载部署工具

用法：
  install.sh [选项] [-- <deploy.sh 参数>]

示例：
  curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/scripts/deploy/install.sh \
    -o noj-install.sh
  bash noj-install.sh --ref v0.1.0 --dir /opt/neuro-oj
  bash noj-install.sh --ref v0.1.0 --dir /opt/neuro-oj -- --dry-run

选项：
  --repo URL             GitHub 仓库地址（默认 Neuro-OJ/neuro-oj）
  --ref REF              固定分支或 Release tag（默认 v0.1.0）
  --dir DIRECTORY        安装目录（默认 /opt/neuro-oj）
  --download-only        只下载源码，不执行生产部署
  --dry-run              只显示下载计划，不下载、不写文件、不启动服务
  -h, --help             显示帮助

环境变量：
  NOJ_BOOTSTRAP_REPOSITORY  默认仓库地址
  NOJ_BOOTSTRAP_REF         默认 ref
  NOJ_BOOTSTRAP_DIR         默认安装目录

目标目录非空时脚本会拒绝覆盖；已有安装请进入目标目录执行 deploy.sh upgrade。
生产环境建议使用不可变 Release tag，并让 --ref 与 .env.prod 中的 NOJ_VERSION 一致。
EOF
}

cleanup() {
  if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
    rm -rf -- "$TEMP_ROOT"
  fi
}
trap cleanup EXIT

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --repo|--repository)
        (($# >= 2)) || fail "$1 需要一个仓库地址"
        REPOSITORY="$2"
        shift
        ;;
      --repo=*|--repository=*) REPOSITORY="${1#*=}" ;;
      --ref)
        (($# >= 2)) || fail "--ref 需要一个版本 ref"
        REF="$2"
        shift
        ;;
      --ref=*) REF="${1#*=}" ;;
      --dir|--target-dir)
        (($# >= 2)) || fail "$1 需要一个安装目录"
        TARGET_DIR="$2"
        shift
        ;;
      --dir=*|--target-dir=*) TARGET_DIR="${1#*=}" ;;
      --download-only) DOWNLOAD_ONLY=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      --)
        shift
        DEPLOY_ARGS+=("$@")
        break
        ;;
      *) fail "未知参数：$1；部署参数请放在 -- 之后" ;;
    esac
    shift
  done
}

validate_inputs() {
  [[ "$REPOSITORY" == https://* ]] ||
    fail "仓库地址必须使用 HTTPS"
  [[ "$REPOSITORY" != *[[:space:]]* && "$REPOSITORY" != *'@'* &&
    "$REPOSITORY" != *'?'* && "$REPOSITORY" != *'#'* ]] ||
    fail "仓库地址包含不支持的字符"
  REPOSITORY="${REPOSITORY%/}"
  REPOSITORY="${REPOSITORY%.git}"

  [[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != /* && "$REF" != */ &&
    "$REF" != *'..'* && "$REF" != *//* ]] ||
    fail "ref 只能包含安全的分支或 Release tag 字符"
  [[ -n "$REF" ]] || fail "ref 不能为空"

  [[ -n "$TARGET_DIR" && "$TARGET_DIR" != "/" && "$TARGET_DIR" != "." &&
    "$TARGET_DIR" != ".." ]] ||
    fail "安装目录不安全或为空"
  [[ "$TARGET_DIR" != *$'\n'* && "$TARGET_DIR" != *$'\r'* ]] ||
    fail "安装目录不能包含换行符"

  ARCHIVE_URL="$REPOSITORY/archive/$REF.tar.gz"
}

check_dependencies() {
  command -v tar >/dev/null 2>&1 || fail "找不到 tar，请先安装 tar"
  if command -v curl >/dev/null 2>&1; then
    return 0
  fi
  command -v wget >/dev/null 2>&1 || fail "需要 curl 或 wget，请先安装其中一个"
}

check_target() {
  [[ ! -L "$TARGET_DIR" ]] || fail "安装目录不能是符号链接：$TARGET_DIR"
  if [[ -e "$TARGET_DIR" ]]; then
    [[ -d "$TARGET_DIR" ]] || fail "安装路径已存在但不是目录：$TARGET_DIR"
    local -a entries=()
    shopt -s nullglob dotglob
    entries=("$TARGET_DIR"/*)
    shopt -u nullglob dotglob
    ((${#entries[@]} == 0)) ||
      fail "安装目录非空，为避免覆盖已有配置或部署而停止：${TARGET_DIR}；已有安装请执行 deploy.sh upgrade"
  fi
}

download_archive() {
  ARCHIVE_PATH="$TEMP_ROOT/source.tar.gz"
  printf '下载源码归档：%s\n' "$ARCHIVE_URL" >&2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 3 --connect-timeout 15 --output "$ARCHIVE_PATH" "$ARCHIVE_URL" ||
      fail "源码下载失败，请检查仓库、ref、网络或代理配置"
  else
    wget --https-only --tries=3 --timeout=20 --quiet --output-document="$ARCHIVE_PATH" "$ARCHIVE_URL" ||
      fail "源码下载失败，请检查仓库、ref、网络或代理配置"
  fi
  [[ -s "$ARCHIVE_PATH" ]] || fail "下载的源码归档为空"
}

validate_archive() {
  local archive="$1" entry root_count listing_file verbose_file
  local -a roots=()

  listing_file="$TEMP_ROOT/archive.list"
  verbose_file="$TEMP_ROOT/archive.verbose"
  tar -tzf "$archive" >"$listing_file" 2>/dev/null ||
    fail "源码归档格式无效"
  while IFS= read -r entry; do
    [[ "$entry" != /* ]] || fail "源码归档包含绝对路径，拒绝解压"
    case "/$entry/" in
      */../*) fail "源码归档包含目录穿越路径，拒绝解压" ;;
    esac
  done <"$listing_file"

  while IFS= read -r entry; do
    roots+=("$entry")
  done < <(awk -F/ 'NF { print $1 }' "$listing_file" | sort -u)
  root_count="${#roots[@]}"
  [[ "$root_count" -eq 1 && -n "${roots[0]}" ]] ||
    fail "源码归档必须包含一个顶层项目目录"
  ARCHIVE_ROOT="${roots[0]}"

  # 允许仓库自身的安全相对符号链接（例如 CLAUDE.md -> AGENTS.md），
  # 但拒绝绝对链接或包含 .. 的链接，避免解压时绕出临时目录。
  local listing type
  local link_target
  tar -tvzf "$archive" >"$verbose_file" 2>/dev/null ||
    fail "无法检查源码归档条目"
  while IFS= read -r listing; do
    type="${listing:0:1}"
    [[ "$type" != "h" ]] || fail "源码归档包含硬链接，拒绝解压"
    if [[ "$type" == "l" ]]; then
      link_target="${listing##* -> }"
      [[ "$link_target" != "$listing" && "$link_target" != /* &&
        "$link_target" != *'..'* ]] ||
        fail "源码归档包含不安全的符号链接，拒绝解压"
    fi
  done <"$verbose_file"
}

install_source() {
  local archive extract_dir source_dir
  if ((DRY_RUN)); then
    ok "[dry-run] 将下载到临时目录并安装到：$TARGET_DIR"
    ok "[dry-run] 源码 ref：$REF"
    return 0
  fi

  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-bootstrap.XXXXXX")"
  chmod 700 "$TEMP_ROOT"
  download_archive
  archive="$ARCHIVE_PATH"
  validate_archive "$archive"
  extract_dir="$TEMP_ROOT/extract"
  mkdir -m 700 "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir" ||
    fail "源码归档解压失败"

  source_dir="$extract_dir/$ARCHIVE_ROOT"
  [[ -f "$source_dir/scripts/deploy/deploy.sh" ]] ||
    fail "下载的 ref 不包含 Neuro OJ 生产部署脚本"
  [[ -f "$source_dir/docker-compose.prod.yml" ]] ||
    fail "下载的 ref 不包含生产 Compose 文件"

  mkdir -p -- "$(dirname -- "$TARGET_DIR")"
  if [[ -d "$TARGET_DIR" ]]; then
    rmdir -- "$TARGET_DIR" || fail "安装目录在下载过程中变为非空，已停止：$TARGET_DIR"
  fi
  mv -- "$source_dir" "$TARGET_DIR"
  ok "源码已安装到：$TARGET_DIR"
}

run_deploy() {
  local status
  ((DOWNLOAD_ONLY)) && {
    ok "仅下载模式完成，未启动生产服务"
    return 0
  }
  if ((DRY_RUN)); then
    ok "[dry-run] 将调用：$TARGET_DIR/scripts/deploy/deploy.sh install"
    return 0
  fi

  set +e
  if ((${#DEPLOY_ARGS[@]} > 0)); then
    bash "$TARGET_DIR/scripts/deploy/deploy.sh" install "${DEPLOY_ARGS[@]}"
  else
    bash "$TARGET_DIR/scripts/deploy/deploy.sh" install
  fi
  status=$?
  set -e
  if ((status != 0)); then
    warn "生产部署失败；可进入 $TARGET_DIR 执行 status 或 logs 排查"
    return "$status"
  fi
  ok "生产部署完成"
}

main() {
  parse_args "$@"
  validate_inputs
  check_dependencies
  check_target
  printf '仓库：%s\nref：%s\n目标目录：%s\n' "$REPOSITORY" "$REF" "$TARGET_DIR"
  printf '下载地址：%s\n' "$ARCHIVE_URL"
  install_source
  run_deploy
}

main "$@"
