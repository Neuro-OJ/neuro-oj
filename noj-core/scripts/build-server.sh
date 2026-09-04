#!/usr/bin/env bash
#
# 编译 noj-server：由 noj-core 源码经 deno compile 产出 linux/amd64 单文件二进制。
# 产物：<repo>/noj-core/bin/noj-server
#
# 仅支持 linux/amd64。

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 仅支持 linux/amd64（对应 x86_64）
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) printf '仅支持 linux/amd64；当前架构 %s 不支持。\n' "$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p bin

deno compile \
  -A --no-check --unstable-byonm --unstable-node-globals \
  --target x86_64-unknown-linux-gnu \
  --output bin/noj-server \
  src/main.ts
