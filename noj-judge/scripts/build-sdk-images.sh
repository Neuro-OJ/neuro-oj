#!/usr/bin/env bash
#
# build-sdk-images.sh — 并行构建 noj-judge 双容器 SDK 镜像
#
# 构建产物：
#   noj-evaluator-python:dev    -- docker/evaluator-python/
#   noj-solution-python:dev     -- docker/solution-python/
#
# 用法：
#   ./scripts/build-sdk-images.sh               # 构建两个镜像打 :dev tag
#   ./scripts/build-sdk-images.sh --no-cache    # 强制重建（忽略缓存）
#   ./scripts/build-sdk-images.sh --tag v0.1.0  # 自定义 tag
#
# 要求：
#   - docker CLI 可用
#   - 在 noj-judge/ 仓库根目录下执行（或使用绝对路径）
#
# 设计稿：openspec/changes/dual-container-judge/design.md §5

set -euo pipefail

# ── 参数解析 ────────────────────────────────────────
NO_CACHE=""
TAG="dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOJ_JUDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cache)
      NO_CACHE="--no-cache"
      shift
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    -h|--help)
      grep "^#" "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

# ── 前置检查 ────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "错误: docker CLI 不可用" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "错误: Docker daemon 未运行" >&2
  exit 1
fi

cd "$NOJ_JUDGE_DIR"

EVAL_IMAGE="noj-evaluator-python:${TAG}"
SOL_IMAGE="noj-solution-python:${TAG}"

echo "=== 并行构建 SDK 镜像 ==="
echo "镜像 1: $EVAL_IMAGE  (构建上下文: docker/evaluator-python/)"
echo "镜像 2: $SOL_IMAGE   (构建上下文: docker/solution-python/)"
echo

# ── 并行构建 ────────────────────────────────────────
# 启动两个 docker build 后台任务，捕获 PID
docker build $NO_CACHE \
  -t "$EVAL_IMAGE" \
  -f docker/evaluator-python/Dockerfile \
  . > /tmp/noj-build-eval.log 2>&1 &
EVAL_PID=$!

docker build $NO_CACHE \
  -t "$SOL_IMAGE" \
  -f docker/solution-python/Dockerfile \
  . > /tmp/noj-build-sol.log 2>&1 &
SOL_PID=$!

# 等待两个构建完成（收集退出码）
EVAL_EXIT=0
SOL_EXIT=0
wait $EVAL_PID || EVAL_EXIT=$?
wait $SOL_PID || SOL_EXIT=$?

# ── 报告结果 ────────────────────────────────────────
echo "--- evaluator-python 构建日志 ---"
cat /tmp/noj-build-eval.log
echo "--- solution-python 构建日志 ---"
cat /tmp/noj-build-sol.log

if [[ $EVAL_EXIT -ne 0 ]]; then
  echo "❌ evaluator-python 构建失败 (exit=$EVAL_EXIT)" >&2
fi
if [[ $SOL_EXIT -ne 0 ]]; then
  echo "❌ solution-python 构建失败 (exit=$SOL_EXIT)" >&2
fi

if [[ $EVAL_EXIT -ne 0 || $SOL_EXIT -ne 0 ]]; then
  exit 1
fi

echo
echo "=== 构建完成 ==="
docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}" \
  | grep -E "REPOSITORY|noj-(evaluator|solution)-python"

# 清理临时日志
rm -f /tmp/noj-build-eval.log /tmp/noj-build-sol.log