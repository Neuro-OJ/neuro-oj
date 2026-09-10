#!/usr/bin/env bash
# 按 Domain 运行 noj-core 测试（本地与 CI 使用同一套环境）。
#
# 用法：bash scripts/test-domain.sh <domain>
#
# 与 CI 的 core-<domain> job 保持一致：迁移/种子 + 域内全部测试。
# 环境变量可覆盖（CI 会显式传入 DATABASE_URL / JWT_SECRET / NOJ_ENV）。
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
用法：bash scripts/test-domain.sh <domain>

可选 domain：
  identity catalog submission contest system community messaging objective
  admin search query gateway content-review observability

示例：bash scripts/test-domain.sh submission
EOF
}

if [[ $# -ne 1 ]]; then
  echo "错误：必须且只能指定一个 domain" >&2
  usage
  exit 2
fi

domain="$1"
known_domains=(
  identity catalog submission contest system community messaging objective
  admin search query gateway content-review observability
)
if [[ ! " ${known_domains[*]} " == *" $domain "* ]]; then
  echo "错误：未知 domain '$domain'" >&2
  usage
  exit 2
fi

cd "$(dirname "$0")/.."

# 与 deno task test 一致的最小环境：bcrypt 低轮数加速、迁移/种子、preload 事务隔离。
export BCRYPT_SALT_ROUNDS="${BCRYPT_SALT_ROUNDS:-4}"
export NOJ_ENV="${NOJ_ENV:-test}"

# 本地可运行性修复（D0）：JWT_SECRET 缺省值。
#
# 此前脚本自身不提供 JWT_SECRET，注释只说明「CI 会显式传入」——导致本地直接执行
# `deno task test:domain <domain>` 时，任何调用 signToken 的用例都会以
# 「环境变量 JWT_SECRET 未设置，无法签发 JWT」失败（例如 contest 域 4 个用例），
# 本地与 CI 行为不一致、且失败原因具有误导性（看起来像产品缺陷）。
#
# 这里提供仅用于测试的固定值（长度 ≥32，满足 main.ts 的强度校验），
# 与 env.e2e.template / .github/workflows/e2e.yml 的固定测试密钥语义一致。
# CI 显式传入的值优先级更高，不受影响。
#
# 注意：DATABASE_URL **不**在此处兜底。未显式设置时测试走 PGlite 内存库
# （零外部依赖，安全）；而一旦在这里默认指向本地 PG，resetDbForTest() 的
# TRUNCATE 会作用到真实开发库。CI 需要真实 PG 时由 CI 显式传入。
export JWT_SECRET="${JWT_SECRET:-noj-test-jwt-secret-fixed-value-with-32-chars-min}"

# 每个 domain job 都需要先有 schema 和种子数据
deno test -A --no-check --preload=tests/preload.ts \
  tests/00_migrate_test.ts tests/seed_bootstrap_admin_test.ts
# 跑该 domain 全部测试（lib/middleware/types/routes/services/mq 递归发现）
deno test -A --no-check --preload=tests/preload.ts "src/domains/$domain/tests"
