#!/usr/bin/env bash
set -euo pipefail

domain="$1"
cd "$(dirname "$0")/.."

# 每个 domain job 都需要先有 schema 和种子数据
deno test -A tests/00_migrate_test.ts tests/seed_bootstrap_admin_test.ts
# 跑该 domain 全部测试（lib/middleware/types/routes/services/mq 递归发现）
deno test -A "src/domains/$domain/tests"
