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
exec cargo run --locked --example oi_wasi_acceptance
