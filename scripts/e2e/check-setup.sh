#!/usr/bin/env bash
#
# E2E 启动脚本回归检查
# 验证本地启动会先刷新 SDK 镜像，且 SDK 构建失败不会继续启动 Compose。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SETUP_SCRIPT="$ROOT_DIR/scripts/e2e/setup.sh"
SDK_BUILDER="$ROOT_DIR/noj-judge/scripts/build-sdk-images.sh"

bash -n "$SETUP_SCRIPT"

if [ ! -x "$SDK_BUILDER" ]; then
  echo "错误: SDK 镜像构建脚本不可执行: $SDK_BUILDER" >&2
  exit 1
fi

if ! grep -Fq 'SDK_IMAGE_BUILDER="${NOJ_E2E_SDK_IMAGE_BUILDER:-' "$SETUP_SCRIPT"; then
  echo "错误: setup.sh 未配置 SDK 构建入口" >&2
  exit 1
fi

builder_line=$(awk '/if ! "\$SDK_IMAGE_BUILDER"; then/ { print NR; exit }' "$SETUP_SCRIPT")
compose_line=$(awk '/docker compose .* up -d --build/ { print NR; exit }' "$SETUP_SCRIPT")
if [ -z "$builder_line" ] || [ -z "$compose_line" ] || [ "$builder_line" -ge "$compose_line" ]; then
  echo "错误: SDK 镜像必须在 Compose 启动前构建" >&2
  exit 1
fi

if ! grep -Fq 'CI:-' "$SETUP_SCRIPT"; then
  echo "错误: setup.sh 未保留 CI 环境分支" >&2
  exit 1
fi

if ! grep -Fq 'SDK 镜像构建失败，停止 E2E 启动' "$SETUP_SCRIPT"; then
  echo "错误: SDK 镜像构建失败缺少明确的终止提示" >&2
  exit 1
fi

if docker info --format '{{.ServerVersion}}' > /dev/null 2>&1; then
  output_file=$(mktemp)
  trap 'rm -f "$output_file"' EXIT
  if CI= NOJ_E2E_SDK_IMAGE_BUILDER=false bash "$SETUP_SCRIPT" >"$output_file" 2>&1; then
    echo "错误: SDK 构建失败时 setup.sh 仍返回成功" >&2
    exit 1
  fi
  if grep -Fq 'E2E 环境就绪' "$output_file"; then
    echo "错误: SDK 构建失败后仍报告 E2E 环境就绪" >&2
    exit 1
  fi
  echo "SDK 构建失败传播检查通过"
else
  echo "跳过 SDK 构建失败传播运行时检查：Docker daemon 未运行"
fi

echo "E2E 启动脚本静态检查通过"
