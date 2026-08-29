#!/usr/bin/env bash
#
# 检查生产镜像发布链路的不可变标签和基础镜像 digest 约束。
#
# 该脚本不访问网络，适合在本地和 CI 的发布前检查中运行。

set -Eeuo pipefail

ROOT_DIR="${NOJ_SUPPLY_CHAIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

fail() {
  printf '[supply-chain] ✗ %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '[supply-chain] ✓ %s\n' "$*"
}

require_file() {
  local path="$1"
  [[ -f "$ROOT_DIR/$path" ]] || fail "找不到文件：$path"
}

check_dockerfiles() {
  local file line
  local files=(
    noj-core/Dockerfile
    noj-ui/Dockerfile
    noj-judge/Dockerfile
    noj-llm-gateway/Dockerfile
    noj-judge/docker/evaluator-python/Dockerfile
    noj-judge/docker/solution-python/Dockerfile
    noj-judge/docker/python/Dockerfile
    noj-judge/docker/solution-ai/Dockerfile
  )

  for file in "${files[@]}"; do
    require_file "$file"
    while IFS= read -r line; do
      [[ "$line" == *'@sha256:'* ]] || fail "$file 存在未固定 digest 的基础镜像：$line"
    done < <(sed -n '/^[[:space:]]*FROM[[:space:]]/p' "$ROOT_DIR/$file")
  done
  ok "生产 Dockerfile 基础镜像均固定 digest"
}

check_compose() {
  local file="$ROOT_DIR/docker-compose.prod.yml"
  require_file "docker-compose.prod.yml"

  grep -q '\${NOJ_VERSION:?NOJ_VERSION is required}' "$file" \
    || fail "生产 Compose 未将 NOJ_VERSION 设为必填"
  if grep -Eq 'NOJ_VERSION:-latest|NOJ_VERSION:=latest|:[[:space:]]*latest(["}]|$)' "$file"; then
    fail "生产 Compose 仍依赖 latest"
  fi

  local line
  while IFS= read -r line; do
    [[ "$line" == *'@sha256:'* ]] || fail "生产 Compose 基础设施镜像未固定 digest：$line"
  done < <(grep -E '^[[:space:]]*image:[[:space:]]+(nginx|postgres|redis|minio/)' "$file")
  ok "生产 Compose 不依赖 latest 且基础设施镜像均固定 digest"
}

check_release_workflow() {
  local file="$ROOT_DIR/.github/workflows/release.yml"
  require_file ".github/workflows/release.yml"
  grep -q 'provenance: mode=max' "$file" || fail "Release workflow 未启用 provenance"
  grep -q 'sbom: true' "$file" || fail "Release workflow 未启用 BuildKit SBOM"
  grep -q 'trivy' "$file" || fail "Release workflow 未配置漏洞扫描"
  local trivy_refs
  trivy_refs="$(grep -E '^[[:space:]]*uses:[[:space:]]+aquasecurity/trivy-action@' "$file" || true)"
  [[ "$(printf '%s\n' "$trivy_refs" | sed '/^$/d' | wc -l | tr -d ' ')" == "2" ]] \
    || fail "Release workflow 必须配置两个 Trivy 步骤"
  while IFS= read -r line; do
    [[ "$line" == *'aquasecurity/trivy-action@v0.36.0'* ]] \
      || fail "Release workflow 使用了未经验证的 Trivy Action 版本：$line"
  done <<< "$trivy_refs"
  grep -q 'cosign' "$file" || fail "Release workflow 未配置镜像签名"
  if grep -Eq ':[[:space:]]*(latest|beta)(["'"'"'[:space:]]|$)' "$file"; then
    fail "Release workflow 仍发布 latest/beta 可变标签"
  fi
  ok "Release workflow 包含安全门禁且不发布 latest/beta"
}

check_release_workflow
check_dockerfiles
check_compose
ok "供应链配置检查通过"
