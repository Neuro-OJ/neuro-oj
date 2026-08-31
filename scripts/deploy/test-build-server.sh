#!/usr/bin/env bash
#
# 真实构建冒烟测试（默认跳过；NOJ_BUILD_SMOKE=1 时执行真实 deno compile）。
# 需要 linux/amd64 主机（CI ubuntu-latest 满足）。
set -Eeuo pipefail

if [[ "${NOJ_BUILD_SMOKE:-0}" != "1" ]]; then
  echo "跳过真实编译（设置 NOJ_BUILD_SMOKE=1 启用）"
  exit 0
fi

# 本脚本位于 <repo>/scripts/deploy/，向上两级即仓库根。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$ROOT_DIR/scripts/../noj-core/scripts/build-server.sh"
BIN="$ROOT_DIR/noj-core/bin/noj-server"

"$BUILD"
test -x "$BIN"
"$BIN" --version >/dev/null 2>&1
echo "✅ noj-server 真实构建冒烟通过：$BIN"
