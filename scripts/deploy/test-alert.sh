#!/usr/bin/env bash
# Neuro OJ 告警投递演练：向 Alertmanager 注入测试告警，验证通知真的有人收到。
#
# 用法：
#   test-alert.sh [ALERTMANAGER_URL] [选项]
#
# 选项：
#   --hold SECONDS   保持告警活跃的秒数（默认 300，足够触发一轮通知）
#   --curl PATH      curl 可执行文件（默认 curl）
#
# 演练会注入 critical / warning 两条 NojNotificationDrill 告警，并在保持期结束后
# 发送 resolved 事件。接收方应同时收到触发与恢复通知；结果按 deploy/monitoring/README.md
# 第 3 节的表格记录。本脚本只负责注入与提示，不代替人工确认。
set -Eeuo pipefail

ALERTMANAGER_URL="${1:-http://alertmanager:9093}"
shift || true
HOLD_SECONDS=300
CURL_BIN="${NOJ_TEST_ALERT_CURL:-curl}"

usage() {
  cat <<'EOF'
用法：test-alert.sh [ALERTMANAGER_URL] [选项]

选项：
  --hold SECONDS   保持告警活跃的秒数（默认 300，足够触发一轮通知）
  --curl PATH      curl 可执行文件（默认 curl）

向 Alertmanager 注入 critical / warning 两条 NojNotificationDrill 告警，
保持期结束后发送 resolved 事件；接收方应同时收到触发与恢复通知。
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --hold) [[ "$#" -ge 2 ]] || { echo "--hold 需要秒数" >&2; exit 2; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "--hold 必须是非负整数" >&2; exit 2; }
      HOLD_SECONDS="$2"; shift 2 ;;
    --curl) [[ "$#" -ge 2 ]] || { echo "--curl 需要路径" >&2; exit 2; }
      CURL_BIN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

command -v "$CURL_BIN" >/dev/null 2>&1 || { echo "找不到 curl：$CURL_BIN" >&2; exit 1; }

starts_at="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"

post_alerts() {
  local payload="$1"
  "$CURL_BIN" --fail --silent --show-error \
    -H 'Content-Type: application/json' \
    -X POST "$ALERTMANAGER_URL/api/v2/alerts" -d "$payload"
}

send_active() {
  post_alerts "$(cat <<EOF
[
  {
    "labels": {
      "alertname": "NojNotificationDrill",
      "severity": "critical",
      "instance": "notification-drill"
    },
    "annotations": {
      "summary": "告警投递演练（critical）",
      "description": "投递演练测试告警，无需处理；请确认接收方收到本通知与后续恢复通知。startsAt=$starts_at"
    },
    "startsAt": "$starts_at"
  },
  {
    "labels": {
      "alertname": "NojNotificationDrill",
      "severity": "warning",
      "instance": "notification-drill"
    },
    "annotations": {
      "summary": "告警投递演练（warning）",
      "description": "投递演练测试告警，无需处理；请确认接收方收到本通知与后续恢复通知。startsAt=$starts_at"
    },
    "startsAt": "$starts_at"
  }
]
EOF
  )"
}

send_resolved() {
  local ends_at
  ends_at="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
  post_alerts "$(cat <<EOF
[
  {
    "labels": {
      "alertname": "NojNotificationDrill",
      "severity": "critical",
      "instance": "notification-drill"
    },
    "annotations": {
      "summary": "告警投递演练（critical）已恢复",
      "description": "投递演练结束，本条为恢复通知。"
    },
    "startsAt": "$starts_at",
    "endsAt": "$ends_at"
  },
  {
    "labels": {
      "alertname": "NojNotificationDrill",
      "severity": "warning",
      "instance": "notification-drill"
    },
    "annotations": {
      "summary": "告警投递演练（warning）已恢复",
      "description": "投递演练结束，本条为恢复通知。"
    },
    "startsAt": "$starts_at",
    "endsAt": "$ends_at"
  }
]
EOF
  )"
}

echo "[drill] 向 $ALERTMANAGER_URL 注入 NojNotificationDrill 测试告警（critical + warning）"
send_active || { echo "注入失败：请检查 Alertmanager 地址与网络" >&2; exit 1; }
echo "[drill] 已注入，保持 ${HOLD_SECONDS} 秒……接收方现在应收到触发通知"

if ((HOLD_SECONDS > 0)); then
  sleep "$HOLD_SECONDS"
fi

echo "[drill] 发送恢复（resolved）事件，接收方应收到恢复通知"
send_resolved || { echo "恢复事件发送失败" >&2; exit 1; }

cat <<'EOF'
[drill] 演练完成。请确认：
  1. 预定接收方在触发阶段收到了 critical 与 warning 通知；
  2. 预定接收方在恢复阶段收到了 resolved 通知；
  3. 按 deploy/monitoring/README.md 第 3 节表格记录演练时间与结果。
EOF
