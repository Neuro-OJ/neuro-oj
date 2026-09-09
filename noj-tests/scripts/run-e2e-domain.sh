#!/usr/bin/env bash
# 按 Domain 运行 noj-tests E2E（本地与 CI 使用同一套命令）。
#
# 用法：bash scripts/run-e2e-domain.sh <domain>
#
# 注意：本地运行需要完整的 E2E 栈（docker compose -f docker-compose.e2e.yml），
# env.e2e.template 会设置 NOJ_RUN_E2E=1；未启动栈时用例会被跳过。
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
用法：bash scripts/run-e2e-domain.sh <domain>

可选 domain：
  identity catalog submission contest system community messaging objective
  admin cross-domain browser staging

示例：bash scripts/run-e2e-domain.sh submission
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
  admin cross-domain browser staging
)
if [[ ! " ${known_domains[*]} " == *" $domain "* ]]; then
  echo "错误：未知 domain '$domain'" >&2
  usage
  exit 2
fi

cd "$(dirname "$0")/.."
if [[ ! -d "e2e/$domain" ]]; then
  echo "错误：目录 e2e/$domain 不存在" >&2
  exit 2
fi
deno test -A --env-file=../env.e2e.template "e2e/$domain/"
