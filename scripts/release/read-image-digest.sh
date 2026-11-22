#!/usr/bin/env bash
# 读取镜像引用（如 ghcr.io/neuro-oj/noj-ui:v0.11.0）当前指向的 digest，输出到 stdout。
#
# 用法：read-image-digest.sh <镜像引用> [--allow-missing]
#   --allow-missing：标签不存在时输出空串并以 0 退出（用于「标签是否已存在」判断）。
#
# 背景（v0.11.0-rc.1 发布）：原写法
#   docker buildx imagetools inspect "$ref" | awk '/^Digest:/ {print $2; exit}'
# 在 `pipefail` 下推送后立即回读，偶发以 255 退出且无任何错误输出，导致已推送成功的
# 镜像被判失败。这里先完整读取 inspect 输出、再解析，不让 awk 提前关闭管道；
# 读取失败时打印错误并有界重试，兼容 GHCR 推送后短暂的读不一致。
set -Eeuo pipefail

ref="${1:?用法：read-image-digest.sh <镜像引用> [--allow-missing]}"
allow_missing=false
[[ "${2:-}" == "--allow-missing" ]] && allow_missing=true

attempts="${READ_DIGEST_ATTEMPTS:-5}"
delay="${READ_DIGEST_DELAY_SECONDS:-5}"

for ((i = 1; i <= attempts; i++)); do
  status=0
  output="$(docker buildx imagetools inspect "$ref" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    digest="$(awk '/^Digest:/ {print $2; exit}' <<<"$output")"
    if [[ -n "$digest" ]]; then
      printf '%s\n' "$digest"
      exit 0
    fi
    echo "::warning::$ref 的 inspect 输出缺少 Digest 行（第 $i/$attempts 次）" >&2
  elif [[ "$allow_missing" == true ]] && grep -qiE 'not found|manifest unknown|name unknown' <<<"$output"; then
    exit 0
  else
    echo "::warning::读取 $ref 失败（第 $i/$attempts 次，退出码 $status）：$output" >&2
  fi
  ((i < attempts)) && sleep "$((delay * i))"
done

echo "::error::多次读取 $ref 的 digest 均失败" >&2
exit 1
