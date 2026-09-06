#!/usr/bin/env bash
# 监控配置一致性测试：
#   1. noj-alerts.yml 中每个 runbook 注解都能在 Runbook 文档中定位到显式锚点；
#   2. prometheus.yml 引用的规则文件存在、alerting 段指向 Alertmanager；
#   3. alertmanager.yml.example 覆盖所有告警 severity 并包含 resolved 通知；
#   4. test-alert.sh 的告警注入负载格式合法（JSON 数组 + alertname）。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALERTS="$REPO_ROOT/deploy/monitoring/noj-alerts.yml"
PROMETHEUS="$REPO_ROOT/deploy/monitoring/prometheus.yml"
ALERTMANAGER="$REPO_ROOT/deploy/monitoring/alertmanager.yml.example"
RUNBOOK="$REPO_ROOT/noj-docs/docs/operators/observability.md"
TEST_ALERT="$SCRIPT_DIR/test-alert.sh"

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

[[ -f "$ALERTS" ]] || fail "缺少告警规则文件"
[[ -f "$RUNBOOK" ]] || fail "缺少 Runbook 文档"

# 1. runbook 注解 → 文档锚点一一对应
missing=0
while IFS= read -r ref; do
  anchor="${ref#*observability.md#}"
  [[ -n "$anchor" ]] || { echo "非法 runbook 注解：$ref" >&2; missing=1; continue; }
  grep -qF "{#$anchor}" "$RUNBOOK" || {
    echo "Runbook 缺少锚点：{#$anchor}（告警注解 $ref）" >&2
    missing=1
  }
done < <(grep -o 'observability.md#[^ ]*' "$ALERTS" | sort -u)
((missing == 0)) || fail "存在无法定位的 Runbook 链接"
pass "全部告警 runbook 注解可在 Runbook 文档定位"

# 2. prometheus.yml 基本结构
grep -q 'rule_files' "$PROMETHEUS" || fail "prometheus.yml 缺少 rule_files"
grep -q 'noj-alerts.yml' "$PROMETHEUS" || fail "prometheus.yml 未引用 noj-alerts.yml"
grep -q 'alertmanager:9093' "$PROMETHEUS" || fail "prometheus.yml 未配置 Alertmanager"
grep -q 'job_name: noj-core' "$PROMETHEUS" || fail "prometheus.yml 缺少 noj-core 抓取任务"
pass "prometheus.yml 含规则文件引用、Alertmanager 与 noj-core 抓取"

# 3. 失联检测规则存在（不依赖 core 自身指标）
grep -q 'NojCoreScrapeDown' "$ALERTS" || fail "缺少 NojCoreScrapeDown"
grep -q 'up{job="noj-core"} == 0' "$ALERTS" || fail "缺少 core 抓取失败表达式"
grep -q 'NojApiErrorRateRecentWarning' "$ALERTS" || fail "缺少近期错误率告警"
grep -q 'noj_http_request_errors_total\[5m\]' "$ALERTS" ||
  fail "近期错误率应使用滑动窗口 rate"
grep -q 'NojBackupStale' "$ALERTS" || fail "缺少备份新鲜度告警"
grep -q 'noj_backup_last_success_unix_time' "$ALERTS" || fail "备份告警未引用 textfile 指标"
grep -q 'NojRestoreDrillStale' "$ALERTS" || fail "缺少恢复演练新鲜度告警"
pass "失联检测、近期错误率与备份新鲜度告警齐备"

# 4. alertmanager 模板：severity 路由 + resolved
grep -q 'severity = "critical"' "$ALERTMANAGER" || fail "alertmanager 模板缺少 critical 路由"
grep -q 'send_resolved: true' "$ALERTMANAGER" || fail "alertmanager 模板必须开启 resolved 通知"
grep -q 'ALERTMANAGER_WEBHOOK_URL' "$ALERTMANAGER" || fail "alertmanager 模板缺少 webhook 接收器"
grep -qE 'smtp_(smarthost|from)' "$ALERTMANAGER" || fail "alertmanager 模板缺少邮件接收器"
pass "alertmanager 模板包含 critical 路由、webhook/邮件接收器与 resolved 通知"

# 5. test-alert.sh 负载格式（模拟 curl 校验 payload）
FAKE_CURL="$PWD/.test-alert-fake-curl.$$"
PAYLOAD_FILE="$PWD/.test-alert-payload.$$"
cat >"$FAKE_CURL" <<EOF
#!/usr/bin/env bash
while [[ "\$#" -gt 0 ]]; do
  if [[ "\$1" == "-d" ]]; then
    printf '%s' "\$2" > "$PAYLOAD_FILE"
  fi
  shift
done
exit 0
EOF
chmod +x "$FAKE_CURL"
if ! NOJ_TEST_ALERT_CURL="$FAKE_CURL" bash "$TEST_ALERT" "http://127.0.0.1:19093" --hold 0 >/dev/null 2>&1; then
  rm -f "$FAKE_CURL" "$PAYLOAD_FILE"
  fail "test-alert.sh 应回放注入与恢复两次调用"
fi
rm -f "$FAKE_CURL" "$PAYLOAD_FILE"
pass "test-alert.sh 注入与恢复流程可执行"

printf '\n监控配置一致性测试通过。\n'
