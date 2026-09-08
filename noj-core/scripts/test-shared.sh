#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# 共享/全局测试 + 迁移/种子 + smoke
deno test -A tests/00_migrate_test.ts tests/seed_bootstrap_admin_test.ts
deno test -A \
  tests/shared \
  tests/data \
  tests/app.test.ts \
  tests/db \
  tests/routes \
  tests/smoke.test.ts
