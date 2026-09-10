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

# 每个 domain job 都需要先有 schema 和种子数据
deno test -A --no-check --preload=tests/preload.ts \
  tests/00_migrate_test.ts tests/seed_bootstrap_admin_test.ts
# 跑该 domain 全部测试（lib/middleware/types/routes/services/mq 递归发现）
deno test -A --no-check --preload=tests/preload.ts "src/domains/$domain/tests"
