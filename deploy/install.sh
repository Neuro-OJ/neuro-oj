#!/usr/bin/env bash
# Neuro OJ 一键部署脚本。
#
# 只做三件事：解析版本 → 下载并校验 noj-cli 二进制 → 交给 `noj-cli install`。
# 安装逻辑（部署文件下载与校验、.env.prod 生成、配置向导、镜像验签、健康检查）
# 全部在 noj-cli 内实现，本脚本不重复实现任何一步。
#
# 用法：
#   curl -fsSL https://github.com/Neuro-OJ/neuro-oj/releases/latest/download/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version v0.11.1 --dir /srv/noj
#
# 选项（也可用同名环境变量）：
#   --version <tag>   NOJ_VERSION      目标 Release 标签（缺省为最新正式 Release）
#   --dir <path>      NOJ_DIR          安装目录（缺省 /opt/neuro-oj）
#   --                其余参数原样透传给 `noj-cli install`
#
# 仅供测试覆盖：NOJ_INSTALL_BASE_URL（Release 下载根）、NOJ_INSTALL_SKIP_PLATFORM_CHECK=1、
# NOJ_INSTALL_SKIP_DOCKER_CHECK=1。

set -Eeuo pipefail

REPO="Neuro-OJ/neuro-oj"
BASE_URL="${NOJ_INSTALL_BASE_URL:-https://github.com/${REPO}/releases}"
VERSION="${NOJ_VERSION:-}"
DIR="${NOJ_DIR:-/opt/neuro-oj}"
BIN_NAME="noj-cli-linux-amd64"
PASSTHROUGH=()

say() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || die "--version 需要一个值"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --dir)
      [[ $# -ge 2 ]] || die "--dir 需要一个值"
      DIR="$2"
      shift 2
      ;;
    --dir=*)
      DIR="${1#*=}"
      shift
      ;;
    -h | --help)
      cat <<USAGE
用法: install.sh [--version <tag>] [--dir <path>] [-- <noj-cli install 参数>...]
  --version <tag>  目标 Release 标签（或 NOJ_VERSION；缺省为最新正式 Release）
  --dir <path>     安装目录（或 NOJ_DIR；缺省 /opt/neuro-oj）
USAGE
      exit 0
      ;;
    --)
      shift
      PASSTHROUGH+=("$@")
      break
      ;;
    *)
      PASSTHROUGH+=("$1")
      shift
      ;;
  esac
done

# ---- 1. 平台检查（noj-cli 二进制为 Linux amd64、动态链接 glibc）----
if [[ "${NOJ_INSTALL_SKIP_PLATFORM_CHECK:-}" != "1" ]]; then
  [[ "$(uname -s)" == "Linux" ]] || die "只支持 Linux（当前 $(uname -s)）"
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) die "只支持 amd64（当前 $(uname -m)）" ;;
  esac
  if ldd --version 2>&1 | grep -qi musl; then
    die "检测到 musl（如 Alpine）；noj-cli 需要 glibc 发行版（Debian/Ubuntu/RHEL 等）"
  fi
fi

for cmd in curl sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少依赖：$cmd"
done
if [[ "${NOJ_INSTALL_SKIP_DOCKER_CHECK:-}" != "1" ]]; then
  command -v docker >/dev/null 2>&1 ||
    die "未检测到 Docker，请先安装 Docker Engine 与 Compose 插件：https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 ||
    die "未检测到 docker compose 插件（需要 Compose v2）"
fi

# ---- 2. 解析版本（与二进制、部署文件保持同一标签）----
if [[ -z "$VERSION" ]]; then
  say "解析最新正式 Release…"
  # /releases/latest 只指向非 draft、非 prerelease 的正式版；取重定向目标里的标签。
  effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${BASE_URL}/latest")" ||
    die "无法访问 ${BASE_URL}/latest"
  effective="${effective%/}"
  VERSION="${effective##*/}"
  [[ -n "$VERSION" && "$VERSION" != "latest" ]] ||
    die "无法解析最新版本，请用 --version 显式指定"
fi
[[ "${VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] ||
  die "版本标签格式不合法：${VERSION}（应形如 v0.11.1）"
say "目标版本：${VERSION}，安装目录：${DIR}"

# ---- 3. 下载并校验二进制 ----
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "下载 ${BIN_NAME} 与校验文件…"
curl -fsSL --retry 3 -o "$TMP/$BIN_NAME" "${BASE_URL}/download/${VERSION}/${BIN_NAME}" ||
  die "下载 ${BIN_NAME} 失败（该版本可能没有 CLI 资产）"
curl -fsSL --retry 3 -o "$TMP/$BIN_NAME.sha256" "${BASE_URL}/download/${VERSION}/${BIN_NAME}.sha256" ||
  die "下载 ${BIN_NAME}.sha256 失败"
(cd "$TMP" && sha256sum -c --status "$BIN_NAME.sha256") ||
  die "SHA-256 校验失败，已中止（下载可能被篡改或不完整）"
chmod +x "$TMP/$BIN_NAME"
say "校验通过"

# ---- 4. 准备安装目录（非 root 且无写权限时借助 sudo 创建并交给当前用户）----
if [[ ! -d "$DIR" ]]; then
  if ! mkdir -p "$DIR" 2>/dev/null; then
    command -v sudo >/dev/null 2>&1 || die "无权创建 $DIR，且没有 sudo"
    say "使用 sudo 创建 $DIR"
    sudo mkdir -p "$DIR"
    sudo chown "$(id -u):$(id -g)" "$DIR"
  fi
elif [[ ! -w "$DIR" ]]; then
  die "$DIR 已存在但当前用户不可写；请换用有权限的用户或目录"
fi

# ---- 5. 交给 noj-cli install（它会把自身复制到 <dir>/bin/noj-cli）----
# `curl | bash` 时 stdin 是管道，配置向导需要终端：有 /dev/tty 时把它接回 stdin。
# `${arr[@]+...}` 写法兼容 bash < 4.4 在 `set -u` 下的空数组展开。
say "运行 noj-cli install…"
args=(install --dir "$DIR" --ref "$VERSION" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"})
if [[ -r /dev/tty ]] && (: </dev/tty) 2>/dev/null; then
  "$TMP/$BIN_NAME" "${args[@]}" </dev/tty
else
  "$TMP/$BIN_NAME" "${args[@]}"
fi
say "完成。之后可直接使用：noj-cli status（或 $DIR/bin/noj-cli status）"
