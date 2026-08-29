#!/usr/bin/env bash
#
# Neuro OJ 用户一键安装入口。
#
# 推荐用法：
#   curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash
#
# 入口只下载固定仓库 main 分支中的 bootstrap；实际安装逻辑仍由 bootstrap 从
# 最新 Release 获取，用户也可以传入 --ref 固定版本。

set -Eeuo pipefail

readonly BOOTSTRAP_URL="${NOJ_SETUP_BOOTSTRAP_URL:-https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/scripts/deploy/install.sh}"
tmp_file="$(mktemp "${TMPDIR:-/tmp}/noj-setup.XXXXXX")"
cleanup() { rm -f -- "$tmp_file"; }
trap cleanup EXIT

if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --connect-timeout 15 --output "$tmp_file" "$BOOTSTRAP_URL" || {
    printf '无法下载 NOJ 安装程序。可以先下载后检查：curl -fsSL %s -o noj-install.sh\n' \
      "$BOOTSTRAP_URL" >&2
    exit 1
  }
elif command -v wget >/dev/null 2>&1; then
  wget --https-only --tries=3 --timeout=20 --quiet --output-document="$tmp_file" "$BOOTSTRAP_URL" || {
    printf '无法下载 NOJ 安装程序。可以先下载后检查：wget -O noj-install.sh %s\n' \
      "$BOOTSTRAP_URL" >&2
    exit 1
  }
else
  printf '需要 curl 或 wget。请先安装其中一个，再重新执行一键安装命令。\n' >&2
  exit 1
fi

[[ -s "$tmp_file" ]] || { printf '下载的 NOJ 安装程序为空。\n' >&2; exit 1; }
exec bash "$tmp_file" "$@"
