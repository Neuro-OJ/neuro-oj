#!/usr/bin/env bash
# 在已下载并校验过的 WASI SDK 上执行真实 Worker 路径验收，无全局安装或配置写入。
# 可选第二参数选择分片（供 CI 并行）：wasi | standard | compat | analysis | all（默认）。
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo '用法: bash scripts/check-oi-wasi-toolchain.sh <wasi-sdk-directory> [wasi|standard|compat|analysis|all]' >&2
  exit 2
fi
sdk_dir="$(cd "$1" && pwd)"
shard="${2:-all}"
case "$shard" in
  wasi) build_targets=(--example oi_wasi_acceptance) ;;
  standard) build_targets=(--example oi_standard_acceptance) ;;
  compat) build_targets=(--example oi_wasi_v2_acceptance) ;;
  analysis) build_targets=(--example oi_io_analysis_acceptance) ;;
  all) build_targets=(--examples) ;;
  *)
    echo "未知分片: $shard" >&2
    exit 2
    ;;
esac
export JUDGE_WASI_CC="$sdk_dir/bin/clang"
export JUDGE_WASI_CXX="$sdk_dir/bin/clang++"
export JUDGE_WASI_SYSROOT="$sdk_dir/share/wasi-sysroot"
export JUDGE_WASI_TARGET=wasm32-wasip1
cd "$(dirname "$0")/.."
report_dir="$(mktemp -d)"
trap 'rm -rf "$report_dir"' EXIT

want() { [[ "$shard" == all || "$shard" == "$1" ]]; }

# 分片只编译本组示例，避免每个 runner 重复链接其他分片与资源池基准。
# 之后并发运行同一二进制，避免 cargo 锁串行化。
# NOJ_WASI_OPT_DEPS=1（CI 设置）：仅依赖（wasmtime/cranelift）开 opt-level=3，
# 工作区代码仍为 dev 档；验收输出是确定性成本/摘要，与 CPU 速度无关，
# 但示例在 debug 依赖下运行极慢（单个 ~2 分钟）。
build_args=(--locked "${build_targets[@]}")
if [[ "${NOJ_WASI_OPT_DEPS:-}" == 1 ]]; then
  build_args+=(--config 'profile.dev.package."*".opt-level=3')
fi
cargo build "${build_args[@]}"

# 两个独立进程使用同一基准，报告只包含确定性成本和摘要，不比较墙钟。
# 两个进程并发执行（互相独立），任一失败即整体失败。
run_pair() {
  local example="$1" prefix="$2"
  local bin="target/debug/examples/$example"
  "$bin" > "$report_dir/$prefix-a.json" &
  local pid_a=$!
  "$bin" > "$report_dir/$prefix-b.json" &
  local pid_b=$!
  local status=0
  wait "$pid_a" || status=$?
  wait "$pid_b" || status=$?
  return "$status"
}

if want wasi; then
  target/debug/examples/oi_wasi_acceptance
fi
if want standard; then
  run_pair oi_standard_acceptance worker
  cmp "$report_dir/worker-a.json" "$report_dir/worker-b.json"
  cmp "$report_dir/worker-a.json" ../fixtures/noj-wasm-v3-benchmarks.json
  cat "$report_dir/worker-a.json"
fi
if want compat; then
  run_pair oi_wasi_v2_acceptance compat
  cmp "$report_dir/compat-a.json" "$report_dir/compat-b.json"
  cat "$report_dir/compat-a.json"
fi
if want analysis; then
  # 独立分析规则不进入计量标准清单；两个独立进程的分类成本/来源必须一致。
  run_pair oi_io_analysis_acceptance analysis
  cmp "$report_dir/analysis-a.json" "$report_dir/analysis-b.json"
  cmp "$report_dir/analysis-a.json" ../fixtures/noj-wasm-v3-io-analysis-v1.json
fi
