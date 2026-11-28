#!/usr/bin/env bash
# 在已下载并校验过的 WASI SDK 上执行真实 Worker 路径验收，无全局安装或配置写入。
# 可选第二参数选择分片（供 CI 并行）：wasi | standard | compat | all（默认）。
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo '用法: bash scripts/check-oi-wasi-toolchain.sh <wasi-sdk-directory> [wasi|standard|compat|all]' >&2
  exit 2
fi
sdk_dir="$(cd "$1" && pwd)"
shard="${2:-all}"
case "$shard" in
  wasi) build_targets=(--example oi_wasi_acceptance) ;;
  standard) build_targets=(--example oi_standard_acceptance) ;;
  compat) build_targets=(--example oi_wasi_v2_acceptance) ;;
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

run_wasi() {
  target/debug/examples/oi_wasi_acceptance
}
run_standard() {
  run_pair oi_standard_acceptance worker
  cmp "$report_dir/worker-a.json" "$report_dir/worker-b.json"
  cat "$report_dir/worker-a.json"
}
run_compat() {
  run_pair oi_wasi_v2_acceptance compat
  cmp "$report_dir/compat-a.json" "$report_dir/compat-b.json"
  cat "$report_dir/compat-a.json"
}

if [[ "$shard" == all ]]; then
  # 一次编译后并发执行 3 组验收（独立输出文件，避免多 job 重复编译 90s×3）。
  run_wasi > "$report_dir/out-wasi.log" 2>&1 &
  p_wasi=$!
  run_standard > "$report_dir/out-standard.log" 2>&1 &
  p_standard=$!
  run_compat > "$report_dir/out-compat.log" 2>&1 &
  p_compat=$!
  status=0
  wait "$p_wasi" || status=1
  wait "$p_standard" || status=1
  wait "$p_compat" || status=1
  for name in wasi standard compat; do
    echo "── WASI acceptance: $name ──"
    cat "$report_dir/out-$name.log"
  done
  exit "$status"
fi

if want wasi; then run_wasi; fi
if want standard; then run_standard; fi
if want compat; then run_compat; fi
