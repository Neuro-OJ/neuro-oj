#!/usr/bin/env bash
# noj-core 共享/全局真实 PostgreSQL 测试入口。
set -euo pipefail

cd "$(dirname "$0")/.."
exec deno run -A scripts/test-launcher.ts shared "$@"
