#!/usr/bin/env bash
# 运行 noj-core 共享/全局测试（与 CI 的 core-shared job 一致）。
#
# 用法：bash scripts/test-shared.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# 与 deno task test 一致的最小环境：bcrypt 低轮数加速、preload 事务隔离。
export BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-4}"
export NOJ_ENV="${NOJ_ENV:-test}"

# 共享/全局测试 + 迁移/种子 + smoke
deno test -A --no-check --preload=tests/preload.ts \
  tests/00_migrate_test.ts tests/seed_bootstrap_admin_test.ts
deno test -A --no-check --preload=tests/preload.ts \
  tests/shared \
  tests/data \
  tests/app.test.ts \
  tests/db \
  tests/routes \
  tests/scripts \
  tests/smoke.test.ts
