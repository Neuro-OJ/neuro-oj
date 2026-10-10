#!/usr/bin/env bash
# 开发与 CI 在生产 SDK 相同的固定容器中调用统一构建入口。
set -euo pipefail
if [[ $# != 3 ]]; then
  echo '用法: bash scripts/build-oi-wasi-toolchain.sh <cache> <work> <output>' >&2
  exit 2
fi
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
cache_dir="$(realpath -m "$1")"
work_dir="$(realpath -m "$2")"
output_dir="$(realpath -m "$3")"
test ! -e "$work_dir"
test ! -e "$output_dir"
mkdir -p "$cache_dir" "$(dirname "$work_dir")" "$(dirname "$output_dir")"
mounts=(--mount "type=bind,src=$package_dir,dst=/source,readonly")
declare -A mounted=()
for directory in "$cache_dir" "$(dirname "$work_dir")" "$(dirname "$output_dir")"; do
  if [[ -z "${mounted[$directory]:-}" ]]; then
    mounts+=(--mount "type=bind,src=$directory,dst=$directory")
    mounted[$directory]=1
  fi
done
# 安装依赖和编译均在容器内，宿主只需 Docker；摘要门禁拒绝不同产物。
docker run --rm \
  "${mounts[@]}" \
  --env NOJ_BUILD_OWNER="$(id -u):$(id -g)" \
  debian:bookworm-slim@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867 \
  sh -eu -c '
    apt-get update
    apt-get upgrade -y
    apt-get install -y --no-install-recommends ca-certificates python3 cmake ninja-build git
    python3 /source/scripts/build-oi-wasi-toolchain.py --cache "$1" --work "$2" --output "$3"
    chown -R "$NOJ_BUILD_OWNER" "$1" "$2" "$3"
  ' sh "$cache_dir" "$work_dir" "$output_dir"
