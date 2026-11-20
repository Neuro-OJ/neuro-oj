#!/usr/bin/env bash
#
# E2E 环境停止脚本（P6-B：会话私有）
#
# 用法: bash scripts/e2e/teardown.sh [--session <name>]
#
# 只删除本会话资源：session/project/owner 校验与 compose down 都在
# scripts/e2e/session.ts 的 down 里完成，避免两处逻辑漂移。
# 不再写/删全局 /tmp/noj-e2e-env.sh。

source "$(dirname "$0")/lib.sh"

SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session)
      SESSION="${2:-}"
      shift 2
      ;;
    *)
      fail "未知参数: $1"
      exit 2
      ;;
  esac
done

SESSION="${SESSION:-${NOJ_E2E_SESSION:-}}"
if [ -z "$SESSION" ]; then
  fail "缺少会话名：--session <name> 或 NOJ_E2E_SESSION"
  echo "  现有会话清单位于 noj-tests/test-results/e2e-sessions/*.json" >&2
  exit 2
fi

cd "$ROOT_DIR"
info "停止 session $SESSION（只删除本会话的 project/容器/卷/网络）..."
if deno run -A scripts/e2e/session.ts down --session "$SESSION"; then
  ok "E2E 环境已停止（session: $SESSION）"
else
  fail "清理失败：清单已保留，残留资源可审计；修正后重试同一条命令"
  exit 1
fi
