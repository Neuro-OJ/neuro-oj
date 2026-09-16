#!/usr/bin/env bash
# 运行 noj-core 共享/全局测试（与 CI 的 core-shared job 一致）。
#
# 用法：bash scripts/test-shared.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# 与 deno task test 一致的最小环境：bcrypt 低轮数加速、preload 事务隔离。
export BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-4}"
export NOJ_ENV="${NOJ_ENV:-test}"

# 本地可运行性修复（2026-09-17）：JWT_SECRET 缺省值。
#
# CI 的 core-shared job 走真实 PostgreSQL 且由工作流注入 JWT_SECRET，故脚本自身
# 不提供。但本地直接执行本脚本时（无 DATABASE_URL → PGlite 模式）任何调用
# signToken 的用例都会以「环境变量 JWT_SECRET 未设置」失败，本地与 CI 行为不一致。
# 与 test-domain.sh 同一处理：提供仅用于测试的固定值（≥32 长度）。CI 显式传入的值
# 优先级更高，不受影响。
export JWT_SECRET="${JWT_SECRET:-noj-test-jwt-secret-fixed-value-with-32-chars-min}"

# PGlite 模板缓存必须先与当前 schema-ddl.ts 对齐（2026-09-17 实测修复）。
#
# 背景：`createPGliteInstanceFromTemplate()` 同步加载模板且**不做 hash 校验**，
# 校验只存在于 `ensurePGliteTemplateCached()`。此前只有 `test-domain.sh` 在
# PGlite 模式下重建模板，本脚本没有 —— 于是**缓存冷启动**（新克隆的仓库、CI 缓存
# 未命中、或手动清过 `src/.test-cache`）时模板缺失，`getDb()` 退化为
# `new PGlite()` 创建**零张表**的空库。
#
# 后果具有误导性：`tests/db/migration_0080_backfill_test.ts` 只用 getDb() 而不调用
# resetDbForTest()（后者才会触发 DDL 引导），因此在冷缓存下以
# `relation "community_reports" does not exist` 失败——看起来像产品缺陷，
# 实际是缓存状态问题。热缓存下该用例通过，故该缺陷只在"冷启动 + 本地 PGlite"
# 这一组合下显现（CI 用真实 PG，走不到这条路径）。
#
# 与 test-domain.sh 的既有修复口径一致：PGlite 模式下先校验/重建模板。
if [[ -z "${DATABASE_URL:-}" ]]; then
  deno run -A scripts/prepare-pglite-template.ts >/dev/null
fi

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
