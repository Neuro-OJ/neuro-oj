#!/usr/bin/env bash
# noj-core 全量真实 PostgreSQL 测试入口。
#
# 资源、迁移、seed 和清理由 test-launcher.ts 统一完成；本脚本只保留稳定的
# shell 入口，绝不读取 .env 或把开发数据库当作测试数据库。
set -euo pipefail

cd "$(dirname "$0")/.."
exec deno run -A scripts/test-launcher.ts test "$@"
