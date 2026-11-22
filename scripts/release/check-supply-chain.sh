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
    local stages=() from_parts=() from_image from_image_lower known_stage stage_name from_count as_kw stage_alias
    while IFS= read -r line; do
      read -r -a from_parts <<< "$line"
      from_image="${from_parts[1]}"
      [[ "$from_image" != --platform=* ]] || from_image="${from_parts[2]}"
      from_image_lower="$(printf '%s' "$from_image" | tr '[:upper:]' '[:lower:]')"
      known_stage=false
      if [[ "${#stages[@]}" -gt 0 ]]; then
        for stage_name in "${stages[@]}"; do
          [[ "$from_image_lower" != "$stage_name" ]] || known_stage=true
        done
      fi
      # 内部阶段继承已验证的固定基础镜像，不是新的外部镜像引用。
      [[ "$known_stage" == true || "$from_image" == *'@sha256:'* ]] || fail "$file 存在未固定 digest 的基础镜像：$line"
      from_count="${#from_parts[@]}"
      if [[ "$from_count" -ge 4 ]]; then
        as_kw="$(printf '%s' "${from_parts[from_count-2]}" | tr '[:lower:]' '[:upper:]')"
        if [[ "$as_kw" == AS ]]; then
          stage_alias="$(printf '%s' "${from_parts[from_count-1]}" | tr '[:upper:]' '[:lower:]')"
          stages+=("$stage_alias")
        fi
      fi
    done < <(sed -n '/^[[:space:]]*FROM[[:space:]]/p' "$ROOT_DIR/$file")
  done
  ok "生产 Dockerfile 基础镜像均固定 digest"
}

check_base_image_security_updates() {
  local file
  local python_files=(
    noj-judge/docker/evaluator-python/Dockerfile
    noj-judge/docker/solution-python/Dockerfile
    noj-judge/docker/solution-ai/Dockerfile
  )
  for file in "${python_files[@]}"; do
    require_file "$file"
    grep -q 'apt-get update' "$ROOT_DIR/$file" \
      || fail "$file 未更新 Debian 软件包索引"
    grep -q 'apt-get upgrade' "$ROOT_DIR/$file" \
      || fail "$file 未安装 Debian 安全更新"
    grep -q 'python3 -m pip install --no-cache-dir --upgrade' "$ROOT_DIR/$file" \
      || fail "$file 未升级 Python 打包工具"
    grep -q 'setuptools>=78.1.1' "$ROOT_DIR/$file" \
      || fail "$file 未约束 setuptools 安全版本"
    grep -q 'wheel>=0.46.2' "$ROOT_DIR/$file" \
      || fail "$file 未约束 wheel 安全版本"
    grep -q 'jaraco.context>=6.1.0' "$ROOT_DIR/$file" \
      || fail "$file 未约束 jaraco.context 安全版本"
  done

  require_file "noj-llm-gateway/Dockerfile"
  grep -q 'apk upgrade --no-cache' "$ROOT_DIR/noj-llm-gateway/Dockerfile" \
    || fail "noj-llm-gateway/Dockerfile 未安装 Alpine 安全更新"
  ok "受影响生产 Dockerfile 均包含基础系统安全更新"
}

check_runtime_users() {
  local file="noj-llm-gateway/Dockerfile"
  require_file "$file"
  grep -Eq 'adduser .*(-u 10001|--uid 10001)' "$ROOT_DIR/$file" \
    || fail "$file 未创建固定 UID 的运行用户"
  grep -q 'chown -R noj:noj /app' "$ROOT_DIR/$file" \
    || fail "$file 未授予运行用户应用目录权限"
  grep -q '^USER noj$' "$ROOT_DIR/$file" \
    || fail "$file 未切换到非 root 运行用户"
  ok "LLM Gateway 使用非 root 运行用户"
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
  grep -Fq -- '- name: noj-server' "$file" \
    || fail "Release workflow 未发布 noj-server 镜像"
  grep -q 'needs: verify-release' "$file" || fail "CLI 发布必须等待生产镜像验证"
  grep -q 'deno task test:production' "$file" || fail "CLI 发布缺少生产安装测试"
  grep -q 'sha256sum noj-cli-linux-amd64' "$file" || fail "CLI 发布缺少 SHA-256 校验文件"
  grep -q 'generate-release-set.ts' "$file" || fail "Release workflow 未从已验证 digest 生成发布集"
  grep -Eq 'deno run -A --config deno\.json \.\./scripts/release/generate-release-set\.ts' "$file" \
    || fail "生成发布集必须显式 --config deno.json（Deno 按脚本位置找配置，否则无法解析 @std/path）"
  grep -q 'release-set.json' "$file" || fail "Release workflow 未上传发布集及校验文件"
  grep -q 'provenance: mode=max' "$file" || fail "Release workflow 未启用 provenance"
  grep -q 'sbom: true' "$file" || fail "Release workflow 未启用 BuildKit SBOM"
  grep -q 'trivy' "$file" || fail "Release workflow 未配置漏洞扫描"
  local trivy_refs
  trivy_refs="$(grep -E '^[[:space:]]*uses:[[:space:]]+aquasecurity/trivy-action@' "$file" || true)"
  [[ "$(printf '%s\n' "$trivy_refs" | sed '/^$/d' | wc -l | tr -d ' ')" == "2" ]] \
    || fail "Release workflow 必须配置两个 Trivy 步骤"
  while IFS= read -r line; do
    # 固定到经核验的 v0.36.0 commit SHA（审计 S1：可变 tag 不可信，只认 SHA）
    [[ "$line" == *'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25'* ]] \
      || fail "Release workflow 使用了未经验证的 Trivy Action 版本：$line"
  done <<< "$trivy_refs"
  grep -q 'cosign' "$file" || fail "Release workflow 未配置镜像签名"
  grep -q 'GH_TOKEN: \${{ github.token }}' "$file" \
    || fail "Release workflow 未向来源证明验证配置 GH_TOKEN"
  if grep -Eq ':[[:space:]]*(latest|beta)(["'"'"'[:space:]]|$)' "$file"; then
    fail "Release workflow 仍发布 latest/beta 可变标签"
  fi

  local ide_job release_job
  ide_job="$(awk '
    /^  publish-ide:/ { in_job=1 }
    in_job && /^  [A-Za-z0-9_-]+:/ && $0 !~ /^  publish-ide:/ { exit }
    in_job { print }
  ' "$file")"
  [[ -n "$ide_job" ]] || fail "Release workflow 缺少 publish-ide 任务"
  grep -q 'needs: verify-release' <<< "$ide_job" || fail "IDE 插件发布必须等待生产镜像验证"
  grep -q 'npm ci' <<< "$ide_job" || fail "IDE 插件发布缺少 npm ci"
  grep -q 'npm run check' <<< "$ide_job" || fail "IDE 插件发布缺少类型与格式检查"
  grep -q 'npm test' <<< "$ide_job" || fail "IDE 插件发布缺少单元测试"
  grep -Fq '@vscode/vsce package' <<< "$ide_job" || fail "IDE 插件发布缺少 vsce 打包步骤"
  grep -Fq 'neuro-oj-lmcc-${VERSION#v}.vsix' <<< "$ide_job" || fail "IDE 插件发布未使用约定 VSIX 资产名"
  grep -Fq '${asset}.sha256' <<< "$ide_job" || fail "IDE 插件发布缺少 VSIX SHA-256 校验文件"
  grep -q 'gh release upload' <<< "$ide_job" || fail "IDE 插件发布缺少 Release 资产上传步骤"

  release_job="$(awk '
    /^  publish-release:/ { in_job=1 }
    in_job && /^  [A-Za-z0-9_-]+:/ && $0 !~ /^  publish-release:/ { exit }
    in_job { print }
  ' "$file")"
  [[ -n "$release_job" ]] || fail "Release workflow 缺少 publish-release 任务"
  grep -Eq '^[[:space:]]*publish-ide,' <<< "$release_job" || fail "publish-release 必须等待 publish-ide 完成"

  # 禁止对预发布后缀标签执行 --prerelease=false / --latest，必须显式按 SemVer 后缀分流。
  if ! awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*(if|elif)[[:space:]]+\[\[.*\$VERSION.*=~[[:space:]]/ {
      if (index($0, "^v?[0-9]+\\.[0-9]+\\.[0-9]+-[0-9A-Za-z.-]+$") > 0) {
        branch = "prerelease"
      } else if (index($0, "^v?[0-9]+\\.[0-9]+\\.[0-9]+$") > 0) {
        branch = "stable"
      } else {
        branch = "other"
      }
      next
    }
    /^[[:space:]]*else([[:space:]]|$)/ { branch = "else"; next }
    /^[[:space:]]*fi([[:space:]]|$)/ { branch = ""; next }
    /gh[[:space:]]+release[[:space:]]+edit/ {
      if ($0 ~ /--prerelease=false/ || $0 ~ /--latest/) {
        if (branch != "stable") exit 2
        saw_stable = 1
      } else if ($0 ~ /--draft=false/ && $0 ~ /--prerelease([[:space:]]|$)/) {
        if (branch != "prerelease") exit 3
        saw_pre = 1
      }
    }
    END {
      if (saw_pre != 1 || saw_stable != 1) exit 4
    }
  ' "$file"; then
    fail "Release workflow 禁止无条件或对预发布标签执行 --prerelease=false / --latest"
  fi

  ok "Release workflow 包含安全门禁、IDE 插件发布且保护预发布标签不被转正"
}

check_release_workflow
check_dockerfiles
check_base_image_security_updates
check_runtime_users
check_compose
ok "供应链配置检查通过"
