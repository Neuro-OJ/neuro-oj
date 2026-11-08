#!/usr/bin/env bash
#
# E2E 启动脚本回归检查（P6-B：会话隔离）
#
# 覆盖：
# 1. setup.sh 语法、SDK 构建入口、SDK 早于 compose、SDK 失败传播；
# 2. compose 无固定 container_name，主机端口全部参数化；
# 3. evaluator 网络名按会话注入，judge 使用实际网络名；
# 4. 无全局 /tmp/noj-e2e-env.sh 依赖，项目名/端口由会话清单注入；
# 5. 清理所有权：bash 不自行 compose down，down 前必须校验 session/project/owner。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SETUP_SCRIPT="$ROOT_DIR/scripts/e2e/setup.sh"
TEARDOWN_SCRIPT="$ROOT_DIR/scripts/e2e/teardown.sh"
COMPOSE_FILE="$ROOT_DIR/docker-compose.e2e.yml"
COMPOSE_S3_FILE="$ROOT_DIR/docker-compose.e2e-s3.yml"
SESSION_TS="$ROOT_DIR/scripts/e2e/session.ts"
SDK_BUILDER="$ROOT_DIR/noj-judge/scripts/build-sdk-images.sh"

fail_check() {
  echo "错误: $1" >&2
  exit 1
}

# ── 1. setup.sh 静态契约 ────────────────────────────────────────────
bash -n "$SETUP_SCRIPT"
bash -n "$TEARDOWN_SCRIPT"

[ -x "$SDK_BUILDER" ] || fail_check "SDK 镜像构建脚本不可执行: $SDK_BUILDER"
grep -Fq 'SDK_IMAGE_BUILDER="${NOJ_E2E_SDK_IMAGE_BUILDER:-' "$SETUP_SCRIPT" ||
  fail_check "setup.sh 未配置 SDK 构建入口"
grep -Fq 'SDK 镜像构建失败，停止 E2E 启动' "$SETUP_SCRIPT" ||
  fail_check "SDK 镜像构建失败缺少明确的终止提示"

builder_line=$(awk '/if ! "\$SDK_IMAGE_BUILDER"; then/ { print NR; exit }' "$SETUP_SCRIPT")
compose_line=$(awk '/up -d --build/ { print NR; exit }' "$SETUP_SCRIPT")
if [ -z "$builder_line" ] || [ -z "$compose_line" ] || [ "$builder_line" -ge "$compose_line" ]; then
  fail_check "SDK 镜像必须在 Compose 启动前构建"
fi

# ── 2. compose 无固定 container_name ────────────────────────────────
for file in "$COMPOSE_FILE" "$COMPOSE_S3_FILE"; do
  if grep -Eq '^[[:space:]]*container_name:' "$file"; then
    fail_check "$(basename "$file") 仍含固定 container_name（会话并行会互相顶掉）"
  fi
done

# ── 3. 主机端口全部参数化 ──────────────────────────────────────────
for var in E2E_PG_PORT E2E_REDIS_PORT E2E_CORE_PORT E2E_MINIO_PORT \
  E2E_MINIO_CONSOLE_PORT E2E_LLM_GATEWAY_PORT E2E_LLM_MOCK_PORT \
  E2E_TEST_COORDINATOR_PORT; do
  pattern='${'"$var"':-'
  grep -Fq "$pattern" "$COMPOSE_FILE" ||
    fail_check "docker-compose.e2e.yml 未参数化 $var"
done
if grep -Eq 'ports:[[:space:]]*\["[0-9]+:[0-9]+"\]' "$COMPOSE_FILE"; then
  fail_check "docker-compose.e2e.yml 仍含写死的主机端口映射"
fi

# ── 4. evaluator 网络按会话注入，judge 用实际网络名 ────────────────
grep -Fq 'name: ${E2E_EVALUATOR_NETWORK:-noj-eval-net}' "$COMPOSE_FILE" ||
  fail_check "evaluator 网络名未参数化（会话并行会串网）"
grep -Fq 'JUDGE_EVALUATOR_NETWORK: ${E2E_EVALUATOR_NETWORK:-noj-eval-net}' "$COMPOSE_FILE" ||
  fail_check "judge 未使用实际 evaluator 网络名"

# ── 5. 无全局 /tmp/noj-e2e-env.sh 依赖 ─────────────────────────────
# 只拦「真的读写」：注释与自引用不算；带 [ -f ... ] 守卫的可选 source 也是惰性的
#（judge.sh 里残留的这一行已登记为后续清理项，不应让门禁长期红灯）。
legacy_refs=$(grep -RIn --include='*.sh' --exclude='check-setup.sh'   '/tmp/noj-e2e-env\.sh' "$SCRIPT_DIR" 2>/dev/null |
  grep -v ':[0-9]*:[[:space:]]*#' |
  grep -v '\[ -f /tmp/noj-e2e-env\.sh \]' || true)
if [ -n "$legacy_refs" ]; then
  echo "$legacy_refs" >&2
  fail_check "仍存在全局 /tmp/noj-e2e-env.sh 依赖（会话私有清单才是唯一事实源）"
fi
if grep -Fq 'noj-e2e-env.sh' "$ROOT_DIR/.github/actions/e2e-domain/action.yml" 2>/dev/null; then
  fail_check "action.yml 仍引用全局 /tmp/noj-e2e-env.sh"
fi

# ── 6. 项目名/端口由会话清单注入 ───────────────────────────────────
grep -Fq 'NOJ_E2E_SESSION:?' "$SETUP_SCRIPT" ||
  fail_check "setup.sh 未要求会话上下文（必须由 session.ts up 调用）"
grep -Fq 'COMPOSE_PROJECT_NAME:?' "$SETUP_SCRIPT" ||
  fail_check "setup.sh 未要求 COMPOSE_PROJECT_NAME"
if grep -Fq 'noj-e2e-local' "$SETUP_SCRIPT" "$TEARDOWN_SCRIPT"; then
  fail_check "脚本仍硬编码固定 compose 项目名 noj-e2e-local"
fi
grep -Fq 'composeProjectFor' "$SESSION_TS" ||
  fail_check "session.ts 未按 run 派生 compose project"
grep -Fq 'evaluatorNetworkFor' "$SESSION_TS" ||
  fail_check "session.ts 未按 run 派生 evaluator 网络"

# ── 7. 清理所有权 ─────────────────────────────────────────────────
grep -Fq 'assertSessionOwnership(manifest, name)' "$SESSION_TS" ||
  fail_check "session.ts down 未校验 session/project/owner"
if grep -Eq 'docker compose|docker-compose' "$TEARDOWN_SCRIPT"; then
  fail_check "teardown.sh 自行执行 compose down（必须委托 session.ts 做所有权校验）"
fi
grep -Fq 'session.ts down' "$TEARDOWN_SCRIPT" ||
  fail_check "teardown.sh 未委托 session.ts down"

# ── 8. 会话上下文缺失时 setup.sh 必须立即失败 ─────────────────────
missing_output=$(env -u NOJ_E2E_SESSION -u COMPOSE_PROJECT_NAME bash "$SETUP_SCRIPT" 2>&1 || true)
if ! grep -Fq 'NOJ_E2E_SESSION' <<< "$missing_output"; then
  fail_check "缺少会话上下文时 setup.sh 未给出明确错误"
fi
if grep -Fq 'E2E 环境就绪' <<< "$missing_output"; then
  fail_check "缺少会话上下文时 setup.sh 仍报告就绪"
fi
# bash 3.2（macOS 自带）会把「全角字符紧邻变量名」吞进变量名，导致 `set -u`
# 下 unbound variable 假红；这里直接断言正确参数下不会出现该错误。
if grep -Fq 'unbound variable' <<< "$missing_output"; then
  fail_check "缺少会话上下文时 setup.sh 报 unbound variable（疑似全角字符吞变量名）"
fi

# ── 9. SDK 构建失败传播（需要 Docker）─────────────────────────────
if docker info --format '{{.ServerVersion}}' > /dev/null 2>&1; then
  output_file=$(mktemp)
  trap 'rm -f "$output_file"' EXIT
  if env NOJ_E2E_SESSION=check-setup \
      COMPOSE_PROJECT_NAME=noj-e2e-check-setup-0000 \
      E2E_CORE_PORT=15999 \
      E2E_EVALUATOR_NETWORK=noj-e2e-check-setup-evaluator \
      NOJ_E2E_SDK_IMAGE_BUILDER=false \
      bash "$SETUP_SCRIPT" > "$output_file" 2>&1; then
    fail_check "SDK 构建失败时 setup.sh 仍返回成功"
  fi
  if grep -Fq 'E2E 环境就绪' "$output_file"; then
    fail_check "SDK 构建失败后仍报告 E2E 环境就绪"
  fi
  if ! grep -Fq 'SDK 镜像构建失败，停止 E2E 启动' "$output_file"; then
    fail_check "SDK 构建失败时缺少明确终止提示"
  fi
  echo "SDK 构建失败传播检查通过"
else
  echo "跳过 SDK 构建失败传播运行时检查：Docker daemon 未运行"
fi

echo "E2E 会话隔离静态检查通过"
