#!/usr/bin/env bash
#
# Neuro OJ 内部 bootstrap 与旧版本兼容入口。
#
# 新用户请使用 setup.sh；此文件保留用于旧版本兼容和 setup.sh 的内部引导，不依赖当前
# 工作目录或本地 Git 仓库。
#
# Bootstrap 只负责获取源码；生产 Compose、配置校验和服务生命周期仍由
# 下载后的 scripts/deploy/deploy.sh 负责。

set -Eeuo pipefail

readonly DEFAULT_REPOSITORY="https://github.com/Neuro-OJ/neuro-oj"

REPOSITORY="${NOJ_BOOTSTRAP_REPOSITORY:-$DEFAULT_REPOSITORY}"
REF="${NOJ_BOOTSTRAP_REF:-}"
TARGET_DIR="${NOJ_BOOTSTRAP_DIR:-/opt/neuro-oj}"
CHECK_PORT="${NOJ_BOOTSTRAP_PORT:-8080}"
EXISTING_INSTALL=0
PANEL_MODE="${NOJ_BOOTSTRAP_PANEL:-auto}"
PANEL_MODE_SET=0
PANEL_NAME="none"
PANEL_ROOT="${NOJ_BOOTSTRAP_PANEL_ROOT:-/www/server/panel}"
PANEL_COMMAND="${NOJ_BOOTSTRAP_PANEL_COMMAND:-/usr/bin/bt}"
COMMAND=""
DOWNLOAD_ONLY=0
FILES_ONLY=0
DRY_RUN=0
NON_INTERACTIVE=0
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
section() { printf '\n== %s ==\n' "$*"; }
fail() {
  printf "%b✗%b %s\n" "$RED" "$RESET" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Neuro OJ Linux 独立下载部署工具

新用户请使用仓库根目录的 setup.sh；本脚本作为 setup.sh 的内部 bootstrap，并保留旧版本兼容。

用法：
  install.sh [check|install-env|install] [选项] [-- <deploy.sh 参数>]

示例：
  curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh \
    -o noj-setup.sh
  bash noj-setup.sh --dir /opt/neuro-oj
  bash scripts/deploy/install.sh check       # 旧版本兼容检查
  sudo bash scripts/deploy/install.sh install-env

命令：
  check                  检测 Linux、基础工具、Docker/Compose、资源和端口
  install-env            安装基础工具并重新检测环境（不会安装 Docker）
  install                下载源码并执行生产部署（默认命令）

选项：
  --repo URL             GitHub 仓库地址（默认 Neuro-OJ/neuro-oj）
  --ref REF              固定分支或 Release tag（默认自动选择最新 Release）
  --dir DIRECTORY        安装目录（默认 /opt/neuro-oj）
  --port PORT            检测宿主机端口（默认 8080）
  --panel MODE           面板模式：auto（默认）、baota 或 none
  --download-only        只下载源码，不执行生产部署
  --files-only            只更新安装目录中的部署文件和 noj 命令（内部兼容选项）
  --dry-run              只显示下载计划，不下载、不写文件、不启动服务
  --non-interactive      首次配置不询问，配置不完整时直接失败
  -h, --help             显示帮助

环境变量：
  NOJ_BOOTSTRAP_REPOSITORY  默认仓库地址
  NOJ_BOOTSTRAP_REF         默认 ref
  NOJ_BOOTSTRAP_DIR         默认安装目录
  NOJ_BOOTSTRAP_PANEL       面板模式（默认 auto）

部署参数：
  通过 -- 后传递给下载后的 deploy.sh install，例如 -- --non-interactive

未指定 --ref 时脚本会自动使用仓库最新可用 Release；生产环境也可以显式指定 --ref 固定版本。
目标目录非空时脚本会拒绝覆盖；已有安装请进入目标目录执行 deploy.sh upgrade。
如果目标目录已经是本工具安装的 Neuro OJ，则会保留现有配置并继续部署；其他非空目录仍会拒绝覆盖。
生产环境建议使用不可变 Release tag，并让 --ref 与 .env.prod 中的 NOJ_VERSION 一致。
执行 install 时会在获取 Release、下载源码和写入目标目录前，先展示最低要求与当前主机环境；该步骤不会自动安装 Docker。
install-env 只安装 curl、tar、openssl 和 CA 证书等基础工具；Docker 请按发行版官方文档安装。
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
      check|install-env|install)
        [[ -z "$COMMAND" ]] || fail "只能指定一个命令"
        COMMAND="$1"
        ;;
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
      --port)
        (($# >= 2)) || fail "--port 需要一个端口号"
        CHECK_PORT="$2"
        shift
        ;;
      --port=*) CHECK_PORT="${1#*=}" ;;
      --panel)
        (($# >= 2)) || fail "--panel 需要 auto、baota 或 none"
        PANEL_MODE="$2"
        PANEL_MODE_SET=1
        shift
        ;;
      --panel=*) PANEL_MODE="${1#*=}"; PANEL_MODE_SET=1 ;;
      --download-only) DOWNLOAD_ONLY=1 ;;
      --files-only) FILES_ONLY=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
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
  COMMAND="${COMMAND:-install}"
  case "$PANEL_MODE" in
    auto|baota|none) ;;
    *) fail "--panel 只能是 auto、baota 或 none：$PANEL_MODE" ;;
  esac
}

validate_inputs() {
  [[ "$REPOSITORY" == https://* ]] ||
    fail "仓库地址必须使用 HTTPS"
  [[ "$REPOSITORY" != *[[:space:]]* && "$REPOSITORY" != *'@'* &&
    "$REPOSITORY" != *'?'* && "$REPOSITORY" != *'#'* ]] ||
    fail "仓库地址包含不支持的字符"
  REPOSITORY="${REPOSITORY%/}"
  REPOSITORY="${REPOSITORY%.git}"

  [[ -n "$TARGET_DIR" && "$TARGET_DIR" != "/" && "$TARGET_DIR" != "." &&
    "$TARGET_DIR" != ".." ]] ||
    fail "安装目录不安全或为空"
  [[ "$TARGET_DIR" != *$'\n'* && "$TARGET_DIR" != *$'\r'* ]] ||
    fail "安装目录不能包含换行符"

}

validate_ref() {
  [[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != /* && "$REF" != */ &&
    "$REF" != *'..'* && "$REF" != *//* && -n "$REF" ]] ||
    fail "没有找到有效的 Release。请使用 --ref 指定版本，例如 --ref 0.8.0-rc.1"
  ARCHIVE_URL="$REPOSITORY/archive/$REF.tar.gz"
}

resolve_latest_ref() {
  local repository_slug metadata_url metadata tag
  [[ -n "$REF" ]] && { validate_ref; return 0; }

  [[ "$REPOSITORY" =~ ^https://github\.com/([^/]+/[^/]+)$ ]] ||
    fail "无法自动获取最新版本；请对自定义仓库使用 --ref 指定 Release tag"
  repository_slug="${BASH_REMATCH[1]}"
  metadata_url="https://api.github.com/repos/$repository_slug/releases?per_page=1"
  printf '正在获取最新 Release：%s\n' "$metadata_url" >&2
  if command -v curl >/dev/null 2>&1; then
    metadata="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 3 --connect-timeout 15 --header 'Accept: application/vnd.github+json' \
      --header 'User-Agent: neuro-oj-installer' "$metadata_url")" ||
      fail "无法获取最新 Release，请检查网络，或使用 --ref 显式指定版本"
  else
    metadata="$(wget --https-only --tries=3 --timeout=20 --quiet --header='Accept: application/vnd.github+json' \
      --header='User-Agent: neuro-oj-installer' -O - "$metadata_url")" ||
      fail "无法获取最新 Release，请检查网络，或使用 --ref 显式指定版本"
  fi
  tag="$(awk '
    match($0, /"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"/) {
      value = substr($0, RSTART, RLENGTH)
      sub(/^.*:[[:space:]]*"/, "", value)
      sub(/"$/, "", value)
      print value
      exit
    }
  ' <<<"$metadata")"
  [[ -n "$tag" ]] || fail "仓库没有可用 Release，请使用 --ref 显式指定版本"
  REF="$tag"
  validate_ref
  ok "将使用最新 Release：$REF"
}

check_dependencies() {
  command -v tar >/dev/null 2>&1 || fail "找不到 tar，请先安装 tar"
  if command -v curl >/dev/null 2>&1; then
    return 0
  fi
  command -v wget >/dev/null 2>&1 || fail "需要 curl 或 wget，请先安装其中一个"
}

docker_install_hint() {
  cat >&2 <<'EOF'
Docker Engine 或 Docker Compose v2 不可用。
请按照发行版官方文档安装 Docker Engine 和 Compose plugin：
  https://docs.docker.com/engine/install/
安装后重新执行：bash scripts/deploy/install.sh check
EOF
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

前后端 Compose 自带 Nginx。部署完成后，请在宝塔的网站/反向代理中把域名转发到
127.0.0.1:8080（如修改 NGINX_PORT，请使用修改后的端口）。请先确认该端口没有被
宝塔已有网站或其他服务占用。脚本不会修改已有站点、证书、反向代理、容器或面板配置。

Judge 仍必须使用只服务于 Judge 的 rootless Docker socket，不能填写
/run/docker.sock 或 /var/run/docker.sock。
EOF
  ok "宝塔兼容提示已启用"
}

check_port() {
  local occupied=0
  [[ "$CHECK_PORT" =~ ^[0-9]+$ ]] && ((CHECK_PORT >= 1 && CHECK_PORT <= 65535)) || {
    printf '  - 端口号无效：%s\n' "$CHECK_PORT" >&2
    return 1
  }
  if command -v ss >/dev/null 2>&1; then
    if ss -ltnH 2>/dev/null | awk -v port=":$CHECK_PORT" '$4 ~ (port "$") { found=1 } END { exit !found }'; then
      occupied=1
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$CHECK_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      occupied=1
    fi
  else
    warn "未找到 ss/lsof，无法确认端口 $CHECK_PORT 是否被占用"
    return 0
  fi
  if ((occupied)); then
    printf '  - 端口 %s 已被监听，启动 Nginx 可能失败\n' "$CHECK_PORT" >&2
    return 1
  fi
  ok "端口 $CHECK_PORT 可用"
}

show_environment_requirements() {
  section "安装前环境预览"
  cat <<'EOF'
最低运行要求：
  - Linux x86_64
  - CPU：至少 2 vCPU
  - 内存：至少 264 MiB
  - Swap：至少 2 GiB
  - 目标目录所在磁盘：至少 5 GiB 可用空间
  - Docker 数据目录所在磁盘：至少 5 GiB 可用空间
  - Docker Engine、Docker Compose v2、Bash、tar、OpenSSL，以及 curl 或 wget
  - 可访问 ghcr.io/neuro-oj/；启用 Judge 时还需要独立的 rootless Docker socket

下面将列出当前主机已检测到的环境；资源项是摘要，最终部署仍会执行配置、镜像和健康检查。
EOF
}

check_host() {
  local failed=0 system arch os_name mem_mb swap_mb cpu_count
  local disk_path disk_kb docker_root_dir docker_disk_kb
  show_environment_requirements
  section "检查 Linux 部署环境"
  detect_panel
  show_panel_guidance

  system="$(uname -s 2>/dev/null || true)"
  if [[ "$system" != Linux ]]; then
    printf '  - 当前系统：%s；生产部署脚本仅支持 Linux\n' "${system:-unknown}" >&2
    failed=1
  else
    ok "操作系统：Linux"
  fi

  arch="$(uname -m 2>/dev/null || true)"
  case "$arch" in
    x86_64) ok "CPU 架构：$arch" ;;
    aarch64|arm64)
      printf '  - 当前 CPU 架构：%s；当前生产镜像仅发布 linux/amd64，请使用 x86_64 主机\n' "$arch" >&2
      failed=1
      ;;
    *)
      printf '  - 不支持的 CPU 架构：%s（当前生产镜像仅支持 x86_64）\n' "${arch:-unknown}" >&2
      failed=1
      ;;
  esac
  os_name="unknown"
  [[ -r /etc/os-release ]] && os_name="$(awk -F= '$1 == "PRETTY_NAME" { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release)"
  printf '系统版本：%s\n' "$os_name"

  for command_name in bash tar openssl; do
    if command -v "$command_name" >/dev/null 2>&1; then
      ok "基础工具：$command_name"
    else
      printf '  - 缺少基础工具：%s\n' "$command_name" >&2
      failed=1
    fi
  done
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    ok "下载工具：curl 或 wget"
  else
    printf '  - 缺少下载工具：curl 或 wget\n' >&2
    failed=1
  fi

  if command -v docker >/dev/null 2>&1; then
    ok "Docker CLI：$(docker --version 2>/dev/null || printf '可执行')"
    if docker info >/dev/null 2>&1; then
      ok "Docker daemon：可用"
    else
      printf '  - Docker daemon 未运行或当前用户无权限\n' >&2
      failed=1
    fi
    if docker compose version >/dev/null 2>&1; then
      ok "Docker Compose：v2 可用"
    else
      printf '  - Docker Compose v2 plugin 不可用\n' >&2
      failed=1
    fi
  else
    printf '  - 未安装 Docker CLI\n' >&2
    docker_install_hint
    failed=1
  fi

  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || true)"
  if [[ "$cpu_count" =~ ^[0-9]+$ ]]; then
    printf '已有环境 CPU：%s vCPU\n' "$cpu_count"
  else
    warn "无法读取 CPU 数量"
  fi

  if [[ -r /proc/meminfo ]]; then
    mem_mb="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo)"
    swap_mb="$(awk '/^SwapTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo)"
    printf '已有环境内存：物理内存约 %s MiB\n' "$mem_mb"
    if [[ "$swap_mb" =~ ^[0-9]+$ ]]; then
      printf '已有环境 Swap：约 %s MiB\n' "$swap_mb"
    else
      warn "无法读取 Swap 大小"
    fi
  else
    warn "无法读取 /proc/meminfo，跳过内存和 Swap 摘要"
  fi
  disk_path="$(dirname -- "$TARGET_DIR")"
  [[ -d "$disk_path" ]] || disk_path="/"
  disk_kb="$(df -Pk "$disk_path" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if [[ "$disk_kb" =~ ^[0-9]+$ ]]; then
    printf '已有环境目标磁盘：可用空间约 %s MiB（%s）\n' "$((disk_kb / 1024))" "$disk_path"
  else
    warn "无法读取目标目录所在磁盘空间"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker_root_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    if [[ -n "$docker_root_dir" && -d "$docker_root_dir" ]]; then
      docker_disk_kb="$(df -Pk "$docker_root_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')"
      if [[ "$docker_disk_kb" =~ ^[0-9]+$ ]]; then
        printf '已有环境 Docker 存储：可用空间约 %s MiB（%s）\n' \
          "$((docker_disk_kb / 1024))" "$docker_root_dir"
      else
        warn "无法读取 Docker 数据目录所在磁盘空间"
      fi
    else
      warn "无法读取 Docker 数据目录，跳过 Docker 存储摘要"
    fi
  fi
  check_port || failed=1

  if ((failed)); then
    printf '%s\n' '环境检测失败，请先修复阻断项后重试。' >&2
    return 1
  fi
  ok "环境检测通过"
}

install_env() {
  local package_manager package_command
  [[ "$(uname -s 2>/dev/null || true)" == Linux ]] ||
    fail "install-env 仅支持 Linux"

  if command -v apt-get >/dev/null 2>&1; then
    package_manager=apt-get
    package_command="$package_manager update && $package_manager install -y ca-certificates curl tar openssl"
  elif command -v dnf >/dev/null 2>&1; then
    package_manager=dnf
    package_command="$package_manager install -y ca-certificates curl tar openssl"
  elif command -v yum >/dev/null 2>&1; then
    package_manager=yum
    package_command="$package_manager install -y ca-certificates curl tar openssl"
  elif command -v apk >/dev/null 2>&1; then
    package_manager=apk
    package_command="$package_manager add --no-cache ca-certificates curl tar openssl"
  elif command -v pacman >/dev/null 2>&1; then
    package_manager=pacman
    package_command="$package_manager -Sy --needed --noconfirm ca-certificates curl tar openssl"
  else
    fail "无法识别包管理器；请手动安装 ca-certificates、curl、tar 和 openssl"
  fi
  if ((DRY_RUN)); then
    ok "[dry-run] 将使用 $package_manager 安装基础工具：ca-certificates curl tar openssl"
    ok "[dry-run] 命令：$package_command"
    return 0
  fi
  [[ "${EUID:-$(id -u)}" -eq 0 ]] ||
    fail "install-env 需要 root 权限，请使用 sudo bash scripts/deploy/install.sh install-env"
  case "$package_manager" in
    apt-get) apt-get update; apt-get install -y ca-certificates curl tar openssl ;;
    dnf|yum) "$package_manager" install -y ca-certificates curl tar openssl ;;
    apk) apk add --no-cache ca-certificates curl tar openssl ;;
    pacman) pacman -Sy --needed --noconfirm ca-certificates curl tar openssl ;;
  esac
  ok "基础工具安装完成（包管理器：$package_manager）"
  check_host
}

check_target() {
  [[ ! -L "$TARGET_DIR" ]] || fail "安装目录不能是符号链接：$TARGET_DIR"
  if [[ -e "$TARGET_DIR" ]]; then
    [[ -d "$TARGET_DIR" ]] || fail "安装路径已存在但不是目录：$TARGET_DIR"
    if [[ -f "$TARGET_DIR/scripts/deploy/deploy.sh" &&
      -f "$TARGET_DIR/docker-compose.prod.yml" ]]; then
      EXISTING_INSTALL=1
      ok "检测到已有 Neuro OJ 安装，将保留现有配置并继续部署：$TARGET_DIR"
      return 0
    fi
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
    if ((EXISTING_INSTALL)); then
      ok "[dry-run] 将更新已有 Neuro OJ 的部署文件并保留配置、备份和数据"
    else
      ok "[dry-run] 将下载到临时目录并安装到：$TARGET_DIR"
    fi
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

  if ((EXISTING_INSTALL)); then
    cp -a "$source_dir/docker-compose.prod.yml" "$TARGET_DIR/"
    [[ -f "$source_dir/.env.prod.example" ]] &&
      cp -a "$source_dir/.env.prod.example" "$TARGET_DIR/"
    mkdir -p "$TARGET_DIR/scripts/deploy"
    cp -a "$source_dir/scripts/deploy/." "$TARGET_DIR/scripts/deploy/"
    if [[ -f "$source_dir/noj" ]]; then
      cp -a "$source_dir/noj" "$TARGET_DIR/noj"
      chmod 755 "$TARGET_DIR/noj"
    fi
    if [[ -d "$source_dir/deploy" ]]; then
      mkdir -p "$TARGET_DIR/deploy"
      cp -a "$source_dir/deploy/." "$TARGET_DIR/deploy/"
    fi
    ok "已更新 Neuro OJ 部署文件；保留 .env.prod、备份和数据目录"
    return 0
  fi

  mkdir -p -- "$(dirname -- "$TARGET_DIR")" ||
    fail "无法创建安装目录的上级路径：$(dirname -- "$TARGET_DIR")；请使用有权限的用户，或通过 --dir 指定可写目录"
  if [[ -d "$TARGET_DIR" ]]; then
    rmdir -- "$TARGET_DIR" || fail "安装目录在下载过程中变为非空，已停止：$TARGET_DIR"
  fi
  mv -- "$source_dir" "$TARGET_DIR"
  ok "源码已安装到：$TARGET_DIR"
}

run_deploy() {
  local status deploy_entry
  ((NON_INTERACTIVE)) && DEPLOY_ARGS+=(--non-interactive)
  ((PANEL_MODE_SET)) && DEPLOY_ARGS+=(--panel "$PANEL_MODE")
  ((DOWNLOAD_ONLY || FILES_ONLY)) && {
    ((FILES_ONLY)) && ok "部署文件和 noj 命令已更新，未重启生产服务"
    ((DOWNLOAD_ONLY)) && ok "仅下载模式完成，未启动生产服务"
    return 0
  }
  if ((DRY_RUN)); then
    ok "[dry-run] 将调用：$TARGET_DIR/scripts/deploy/deploy.sh install"
    return 0
  fi

  deploy_entry="$TARGET_DIR/scripts/deploy/deploy.sh"
  if [[ -f "$TARGET_DIR/noj" ]]; then
    deploy_entry="$TARGET_DIR/noj"
  fi
  set +e
  if ((${#DEPLOY_ARGS[@]} > 0)); then
    NOJ_BIN_DIR="${NOJ_BOOTSTRAP_BIN_DIR:-/usr/local/bin}" \
    NOJ_DEPLOY_DEFAULT_VERSION="$REF" \
      bash "$deploy_entry" install "${DEPLOY_ARGS[@]}"
  else
    NOJ_BIN_DIR="${NOJ_BOOTSTRAP_BIN_DIR:-/usr/local/bin}" \
    NOJ_DEPLOY_DEFAULT_VERSION="$REF" \
      bash "$deploy_entry" install
  fi
  status=$?
  set -e
  if ((status != 0)); then
    warn "生产部署失败；可进入 $TARGET_DIR 执行 status 或 logs 排查"
    return "$status"
  fi
  ok "生产部署完成"
}

register_noj_command() {
  ((DOWNLOAD_ONLY || DRY_RUN)) && return 0
  [[ -f "$TARGET_DIR/noj" ]] || {
    warn "当前源码未包含 noj 命令，跳过 PATH 注册"
    return 0
  }
  chmod 755 "$TARGET_DIR/noj"
  NOJ_INTERNAL_REGISTER=1 \
  NOJ_BIN_DIR="${NOJ_BOOTSTRAP_BIN_DIR:-/usr/local/bin}" \
    bash "$TARGET_DIR/noj" register-command ||
    warn "无法自动注册 noj 到 PATH；部署已完成，请手动将 $TARGET_DIR/noj 加入 PATH"
}

main() {
  parse_args "$@"
  case "$COMMAND" in
    check)
      check_host
      ;;
    install-env)
      install_env
      ;;
    install)
      validate_inputs
      check_host
      check_dependencies
      resolve_latest_ref
      check_target
      printf '仓库：%s\nref：%s\n目标目录：%s\n' "$REPOSITORY" "$REF" "$TARGET_DIR"
      printf '下载地址：%s\n' "$ARCHIVE_URL"
      install_source
      run_deploy
      register_noj_command
      ;;
    *)
      fail "未知命令：$COMMAND"
      ;;
  esac
}

if [[ "${NOJ_BOOTSTRAP_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
