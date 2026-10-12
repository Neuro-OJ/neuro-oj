#!/usr/bin/env bash
# 供应链配置检查脚本的正向和负向测试。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/noj-supply-chain-test.XXXXXX")"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

reset_fixture() {
mkdir -p "$TEST_ROOT/.github"
cp -R "$ROOT_DIR/.github/." "$TEST_ROOT/.github/"
# 只复制门禁读取的 Dockerfile，不复制 target/node_modules 或私有开发配置。
while IFS= read -r file; do
  mkdir -p "$TEST_ROOT/$(dirname "$file")"
  cp "$ROOT_DIR/$file" "$TEST_ROOT/$file"
done < <(git -C "$ROOT_DIR" ls-files -- \
  'noj-core/**/Dockerfile' 'noj-core/Dockerfile' \
  'noj-ui/**/Dockerfile' 'noj-ui/Dockerfile' \
  'noj-judge/**/Dockerfile' 'noj-judge/Dockerfile' \
  'noj-llm-gateway/**/Dockerfile' 'noj-llm-gateway/Dockerfile')
cp "$ROOT_DIR/docker-compose.prod.yml" "$TEST_ROOT/docker-compose.prod.yml"

}
reset_fixture

NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" >/dev/null ||
  fail "合法供应链配置检查失败"
pass "合法供应链配置"

sed -i.bak 's/FROM wasi-runtime AS runtime/FROM unknown-runtime AS runtime/' "$TEST_ROOT/noj-judge/Dockerfile"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" >/dev/null 2>&1; then
  fail "未定义的内部阶段/未固定外部镜像未被拒绝"
fi
pass "未定义内部阶段拒绝"
reset_fixture
cp "$ROOT_DIR/noj-judge/Dockerfile" "$TEST_ROOT/noj-judge/Dockerfile"

sed -i.bak '/^USER noj$/d' \
  "$TEST_ROOT/noj-llm-gateway/Dockerfile"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "缺少网关非 root 运行用户的 Dockerfile 未被拒绝"
fi
pass "缺少网关非 root 运行用户拒绝"
reset_fixture

sed -i.bak '/apt-get upgrade -y/d' \
  "$TEST_ROOT/noj-judge/docker/evaluator-python/Dockerfile"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "缺少 Debian 安全更新的 Dockerfile 未被拒绝"
fi
pass "缺少基础系统安全更新拒绝"
reset_fixture

sed -i.bak '/apt-get upgrade -y/d' \
  "$TEST_ROOT/noj-judge/docker/solution-ai/Dockerfile"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "solution-ai 缺少 Debian 安全更新的 Dockerfile 未被拒绝"
fi
pass "solution-ai 基础系统安全更新拒绝"
reset_fixture

sed -i.bak '/setuptools>=78.1.1/d' \
  "$TEST_ROOT/noj-judge/docker/solution-python/Dockerfile"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "缺少 Python 打包工具安全更新的 Dockerfile 未被拒绝"
fi
pass "Python 打包工具安全更新拒绝"
reset_fixture

sed -i.bak 's#aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 \# v0.36.0#aquasecurity/trivy-action@v0.28.0#g' \
  "$TEST_ROOT/.github/workflows/release.yml"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "已知失效的 Trivy Action 引用未被拒绝"
fi
pass "失效 Trivy Action 引用拒绝"
reset_fixture

sed -i.bak '/GH_TOKEN:.*github.token/d' \
  "$TEST_ROOT/.github/workflows/release.yml"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "缺少来源证明验证令牌的工作流未被拒绝"
fi
pass "缺少来源证明验证令牌拒绝"
reset_fixture

sed -i.bak 's#FROM debian:bookworm-slim@sha256:[0-9a-f]*#FROM debian:bookworm-slim#' \
  "$TEST_ROOT/noj-core/Dockerfile"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "未固定基础镜像 digest 未被拒绝"
fi
pass "未固定基础镜像拒绝"
reset_fixture

sed -i.bak 's#FROM debian:bookworm-slim#FROM debian:bookworm-slim@sha256:5ae3c39eb15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867#' \
  "$TEST_ROOT/noj-core/Dockerfile"
sed -i.bak 's#NOJ_VERSION:?NOJ_VERSION is required#NOJ_VERSION:-latest#' \
  "$TEST_ROOT/docker-compose.prod.yml"
if NOJ_SUPPLY_CHAIN_ROOT="$TEST_ROOT" bash "$SCRIPT_DIR/check-supply-chain.sh" \
  >/dev/null 2>&1; then
  fail "latest 生产版本回退未被拒绝"
fi
pass "latest 生产版本拒绝"
reset_fixture

printf '全部供应链配置测试通过\n'
