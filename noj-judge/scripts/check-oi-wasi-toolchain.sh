#!/usr/bin/env bash
# 在已下载并校验过的 WASI SDK 上执行真实 Worker 路径验收，无全局安装或配置写入。
set -euo pipefail
if [[ $# != 1 ]]; then
  echo '用法: bash scripts/check-oi-wasi-toolchain.sh <wasi-sdk-directory>' >&2
  exit 2
fi
sdk_dir="$(cd "$1" && pwd)"
export JUDGE_WASI_CC="$sdk_dir/bin/clang"
export JUDGE_WASI_CXX="$sdk_dir/bin/clang++"
export JUDGE_WASI_SYSROOT="$sdk_dir/share/wasi-sysroot"
export JUDGE_WASI_TARGET=wasm32-wasip1
cd "$(dirname "$0")/.."
cargo run --locked --example oi_wasi_acceptance
report_dir="$(mktemp -d)"
trap 'rm -rf "$report_dir"' EXIT
# 两个独立进程使用同一基准，报告只包含确定性成本和摘要，不比较墙钟。
cargo run --locked --example oi_standard_acceptance > "$report_dir/worker-a.json"
cargo run --locked --example oi_standard_acceptance > "$report_dir/worker-b.json"
cmp "$report_dir/worker-a.json" "$report_dir/worker-b.json"
cmp "$report_dir/worker-a.json" ../fixtures/noj-wasm-v2-benchmarks.json
cat "$report_dir/worker-a.json"
cargo run --locked --example oi_wasi_v2_acceptance > "$report_dir/compat-a.json"
cargo run --locked --example oi_wasi_v2_acceptance > "$report_dir/compat-b.json"
cmp "$report_dir/compat-a.json" "$report_dir/compat-b.json"
cat "$report_dir/compat-a.json"
