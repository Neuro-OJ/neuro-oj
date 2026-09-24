#!/usr/bin/env bash
# 运行 noj-core 全量测试（本地与 CI 使用同一套环境）。
#
# 用法：bash scripts/test-all.sh
#
# 背景（缺陷修复）：此前 `deno task test` 直接内联了一条命令串：
#
#   deno run -A scripts/prepare-pglite-template.ts && \
#     BCRYPT_SALT_ROUNDS=4 env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts
#
# 它只注入了 BCRYPT_SALT_ROUNDS，**没有**注入 NOJ_ENV 与 JWT_SECRET——而这两项
# 恰恰是 CI（`.github/workflows/ci.yml` 的 `Inject or validate JWT_SECRET` 步骤 +
# 各 job 的 `NOJ_ENV: test`）与 `scripts/test-domain.sh` 都会提供的。后果是
# 「本地全量测试」与「CI 分域测试」跑的根本不是同一套环境，实测出三类假失败：
#
#  1. 缺 JWT_SECRET → 7 个用例以「环境变量 JWT_SECRET 未设置，无法签发 JWT」
#     失败（catalog admin-problems 5 + catalog trainings 2）；更严重的是，
#     仓库里 51 个测试文件用 `Deno.env.get("JWT_SECRET")` 做门控，缺失时整批
#     用例被 **静默 ignore**——实测 ignored 从 58 涨到 131，即 73 个用例
#     「看起来通过、实则从未执行」。
#  2. 缺 NOJ_ENV=test → `isRateLimitEnabled()`（rate-limit-env.ts:62）走
#     DB 默认值 true，测试请求被限流成 429，又一批用例失败
#     （catalog problem-bundle 9 个以 `429 != 200` 失败）。
#  3. 上述门控放开后暴露出的真实测试隔离缺陷（EMAIL_PROVIDER 泄漏），
#     见 src/domains/system/tests/routes/admin-settings-email.test.ts。
#
# 因此这里与 test-domain.sh 保持一致地注入环境，使三条测试路径行为统一。
set -euo pipefail

cd "$(dirname "$0")/.."

# 与 CI 的 domain job 对齐：bcrypt 低轮数加速；测试模式关闭限流。
export BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-4}"
export NOJ_ENV="${NOJ_ENV:-test}"

# JWT_SECRET 兜底：仅用于测试的固定值（长度 ≥32，满足 main.ts 的强度校验），
# 与 test-domain.sh / env.e2e.template 的固定测试密钥语义一致。
# CI 显式传入的值优先级更高，不受影响。
export JWT_SECRET="${JWT_SECRET:-noj-test-jwt-secret-fixed-value-with-32-chars-min}"

# 本 task 始终走 PGlite 内存库（与原 `deno task test` 的 `env -u DATABASE_URL`
# 语义一致）：零外部依赖，且不会因误设 DATABASE_URL 而让 resetDbForTest() 的
# TRUNCATE 作用到真实开发库。需要真实 PG 的分域测试请用 `deno task test:domain`。
#
# 模板缓存必须与当前 schema-ddl.ts 一致，否则会静默复用过期模板。
deno run -A scripts/prepare-pglite-template.ts >/dev/null

exec env -u DATABASE_URL deno test -A --no-check --preload=tests/preload.ts "$@"
