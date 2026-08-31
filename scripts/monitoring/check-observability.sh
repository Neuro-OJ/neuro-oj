#!/usr/bin/env bash
# 生产观测快速检查：不修改服务状态，不需要 Docker。
set -euo pipefail

BASE_URL="${NOJ_OBSERVABILITY_BASE_URL:-http://127.0.0.1:8000}"
CHECK_NOTIFICATIONS=false

usage() {
  cat <<'EOF'
用法：check-observability.sh [--base-url URL] [--check-notifications]

检查 core 的 liveness、readiness、Prometheus 指标端点和告警通知前置条件。
--check-notifications 要求 ALERTMANAGER_URL 已配置，并验证其 URL 可解析。
EOF
}

while (($# > 0)); do
  case "$1" in
    --base-url)
      [[ $# -ge 2 ]] || { echo "--base-url 缺少参数" >&2; exit 2; }
      BASE_URL="$2"
      shift 2
      ;;
    --check-notifications)
      CHECK_NOTIFICATIONS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_ok() {
  local name="$1" url="$2" expected="$3" body
  body="$(curl --fail --silent --show-error --max-time 5 "$url")" || {
    echo "[失败] ${name}：无法访问 ${url}" >&2
    return 1
  }
  grep -q "$expected" <<<"$body" || {
    echo "[失败] ${name}：响应缺少 ${expected}" >&2
    return 1
  }
  echo "[通过] ${name}"
}

require_ok "liveness" "$BASE_URL/health/live" '"status":"alive"'
require_ok "readiness" "$BASE_URL/health/ready" '"status":"ready"'

metrics_body="$(curl --fail --silent --show-error --max-time 5 "$BASE_URL/metrics")" || {
  echo "[失败] metrics：无法访问 $BASE_URL/metrics" >&2
  exit 1
}
grep -q '^noj_database_up ' <<<"$metrics_body" || { echo "[失败] metrics：缺少 noj_database_up" >&2; exit 1; }
grep -q '^noj_judge_workers ' <<<"$metrics_body" || { echo "[失败] metrics：缺少 noj_judge_workers" >&2; exit 1; }
echo "[通过] metrics"

if [[ "$CHECK_NOTIFICATIONS" == true ]]; then
  [[ -n "${ALERTMANAGER_URL:-}" ]] || {
    echo "[失败] 通知链路：ALERTMANAGER_URL 未配置" >&2
    exit 1
  }
  curl --fail --silent --show-error --max-time 5 "$ALERTMANAGER_URL/-/ready" >/dev/null || {
    echo "[失败] 通知链路：Alertmanager 未就绪" >&2
    exit 1
  }
  echo "[通过] 通知链路"
else
  echo "[提示] 未检查通知链路；演练时请增加 --check-notifications"
fi
