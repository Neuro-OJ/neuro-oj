#!/usr/bin/env bash
#
# Neuro OJ 唯一公开的一键安装入口。
#
# 推荐用法：
#   curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash
#
# setup.sh 只负责获取内部 bootstrap 并完成首次安装；安装完成后的服务启停、更新
# 和管理统一使用安装目录中的 noj 命令。

set -Eeuo pipefail

readonly BOOTSTRAP_URL="${NOJ_SETUP_BOOTSTRAP_URL:-https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/scripts/deploy/install.sh}"
tmp_file="$(mktemp "${TMPDIR:-/tmp}/noj-setup.XXXXXX")"
cleanup() { rm -f -- "$tmp_file"; }
trap cleanup EXIT

if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --connect-timeout 15 --output "$tmp_file" "$BOOTSTRAP_URL" || {
    printf '无法下载 NOJ 安装程序。请检查网络，或先下载 setup.sh 后人工检查再执行。\n' >&2
    exit 1
  }
elif command -v wget >/dev/null 2>&1; then
  wget --https-only --tries=3 --timeout=20 --quiet --output-document="$tmp_file" "$BOOTSTRAP_URL" || {
    printf '无法下载 NOJ 安装程序。请检查网络，或先下载 setup.sh 后人工检查再执行。\n' >&2
    exit 1
  }
else
  printf '需要 curl 或 wget。请先安装其中一个，再重新执行一键安装命令。\n' >&2
  exit 1
fi

[[ -s "$tmp_file" ]] || { printf '下载的 NOJ 安装程序为空。\n' >&2; exit 1; }
exec bash "$tmp_file" "$@"
