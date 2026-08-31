#!/usr/bin/env bash
#
# Neuro OJ 唯一公开的一键安装入口（薄引导）。
#
# 只负责：下载并 SHA-256 校验 noj-cli 二进制，然后交给 noj-cli 完成
# doctor / deploy init / deploy up 等全部部署与运维。
#
# 推荐用法：
#   curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash
#
# 环境变量：
#   NOJ_CLI_VERSION   noj-cli 版本（默认 latest，可固定如 0.1.0）
#   NOJ_CLI_SHA256    期望的 noj-cli SHA-256（推荐固定，作防篡改锚点）
#   NOJ_INSTALL_DIR   安装目录（默认 /opt/neuro-oj）

set -Eeuo pipefail

readonly BASE_URL="${NOJ_CLI_DOWNLOAD_BASE:-https://github.com/Neuro-OJ/neuro-oj/releases/download}"
readonly VERSION="${NOJ_CLI_VERSION:-latest}"
readonly INSTALL_DIR="${NOJ_INSTALL_DIR:-/opt/neuro-oj}"
readonly BIN_DIR="$INSTALL_DIR/bin"
readonly BIN="$BIN_DIR/noj-cli"
readonly EXPECTED_SHA="${NOJ_CLI_SHA256:-}"

# 仅支持 linux/amd64
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) printf '仅支持 linux/amd64；当前架构 %s 不支持。\n' "$(uname -m)" >&2; exit 1 ;;
esac

if [[ -z "$(command -v curl)" && -z "$(command -v wget)" ]]; then
  printf '需要 curl 或 wget，请先安装其一。\n' >&2
  exit 1
fi

resolve_tag() {
  if [[ "$VERSION" != "latest" ]]; then
    printf '%s' "$VERSION"
    return
  fi
  curl -fsSL "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}

fetch() { # <url> <out>
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 3 --connect-timeout 15 --output "$2" "$1"
  else
    wget --https-only --tries=3 --timeout=20 --quiet --output-document="$2" "$1"
  fi
}

tag="$(resolve_tag)"
[[ -n "$tag" ]] || { printf '无法解析 noj-cli 版本。\n' >&2; exit 1; }

mkdir -p "$BIN_DIR"
tmp="$(mktemp "${TMPDIR:-/tmp}/noj-cli.XXXXXX")"
trap 'rm -f -- "$tmp" "$tmp.sha256"' EXIT

version_without_v="${tag#v}"
asset="noj-cli-linux-amd64"
url="$BASE_URL/$version_without_v/$asset"

fetch "$url" "$tmp"
fetch "$url.sha256" "$tmp.sha256"

actual="$(sha256sum "$tmp" | awk '{print $1}')"
expected="$(awk '{print $1}' "$tmp.sha256")"
if [[ -n "$EXPECTED_SHA" ]]; then
  expected="$EXPECTED_SHA"
fi
[[ "$actual" == "$expected" ]] || {
  printf 'noj-cli SHA-256 校验失败：期望 %s，实际 %s\n' "$expected" "$actual" >&2
  exit 1
}

install -m 0755 "$tmp" "$BIN"
ln -sf "$BIN" "$INSTALL_DIR/noj"
exec "$BIN" "$@"
