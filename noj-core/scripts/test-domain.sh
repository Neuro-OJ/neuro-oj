#!/usr/bin/env bash
# 按 Domain 运行真实 PostgreSQL 测试。
# 用法：bash scripts/test-domain.sh <domain> [Deno 测试参数]
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ $# -lt 1 ]]; then
  echo "错误：必须指定一个 domain" >&2
  exit 2
fi
domain="$1"
shift
exec deno run -A scripts/test-launcher.ts domain "$domain" "$@"
