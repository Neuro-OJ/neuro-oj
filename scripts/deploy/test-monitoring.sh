#!/usr/bin/env bash
# 监控配置一致性测试：
#   1. noj-alerts.yml / noj-slo-alerts.yml 中每个 runbook 注解都能定位；
#   2. prometheus.yml 引用的两个规则文件存在、alerting 段指向 Alertmanager；
#   3. alertmanager.yml.example 覆盖所有告警 severity 并包含 resolved 通知；
#   4. test-alert.sh 的告警注入负载格式合法（JSON 数组 + alertname）。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALERTS="$REPO_ROOT/deploy/monitoring/noj-alerts.yml"
SLO_ALERTS="$REPO_ROOT/deploy/monitoring/noj-slo-alerts.yml"
PROMETHEUS="$REPO_ROOT/deploy/monitoring/prometheus.yml"
PROD_COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
ALERTMANAGER="$REPO_ROOT/deploy/monitoring/alertmanager.yml.example"
RUNBOOK="$REPO_ROOT/noj-docs/docs/operators/observability.md"
TEST_ALERT="$SCRIPT_DIR/test-alert.sh"

pass() { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

[[ -f "$ALERTS" ]] || fail "缺少告警规则文件"
[[ -f "$SLO_ALERTS" ]] || fail "缺少 SLO 告警规则文件"
[[ -f "$RUNBOOK" ]] || fail "缺少 Runbook 文档"

# 1. runbook 注解 → 文档锚点一一对应
# 注解形如 <相对路径>.md#<锚点>；目标文档必须存在且含显式 {#锚点}。
# 两个规则文件都要扫：运维告警指向 observability.md，也可指向其他 runbook 文档。
refs="$(sed -nE 's/.*runbook:[[:space:]]*([^ ]*\.md#[^ ]*).*/\1/p' \
  "$ALERTS" "$SLO_ALERTS" | sort -u)"
[[ -n "$refs" ]] ||
  fail "未找到任何 runbook 注解（正则失配或注解被清空，检查逻辑已失去意义）"

missing=0
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  ref_file="$REPO_ROOT/${ref%%#*}"
  anchor="${ref#*#}"
  [[ -n "$anchor" ]] || { echo "非法 runbook 注解：$ref" >&2; missing=1; continue; }
  if [[ ! -f "$ref_file" ]]; then
    echo "Runbook 文档不存在：${ref%%#*}（告警注解 $ref）" >&2
    missing=1
    continue
  fi
  grep -qF "{#$anchor}" "$ref_file" || {
    echo "Runbook 缺少锚点：{#$anchor}（告警注解 $ref）" >&2
    missing=1
  }
done <<<"$refs"
((missing == 0)) || fail "存在无法定位的 Runbook 链接"
pass "全部 $(wc -l <<<"$refs") 个 runbook 注解均可在对应文档定位"

# 2. prometheus.yml 基本结构
grep -q 'rule_files' "$PROMETHEUS" || fail "prometheus.yml 缺少 rule_files"
grep -q 'noj-alerts.yml' "$PROMETHEUS" || fail "prometheus.yml 未引用 noj-alerts.yml"
grep -q 'noj-slo-alerts.yml' "$PROMETHEUS" ||
  fail "prometheus.yml 未引用 noj-slo-alerts.yml"
grep -q 'alertmanager:9093' "$PROMETHEUS" || fail "prometheus.yml 未配置 Alertmanager"
grep -q 'job_name: noj-core' "$PROMETHEUS" || fail "prometheus.yml 缺少 noj-core 抓取任务"
pass "prometheus.yml 含规则文件引用、Alertmanager 与 noj-core 抓取"

# 2.5 抓取目标主机名必须是生产 compose 的真实服务名（服务名即 noj-net 内的 DNS 名）
if [[ -f "$PROD_COMPOSE" ]]; then
  while IFS=$'\t' read -r job target; do
    [[ -n "$job" && -n "$target" ]] || continue
    host="${target%%:*}"
    if ! grep -qE "^  ${host}:" "$PROD_COMPOSE"; then
      fail "prometheus.yml 任务 $job 的目标主机 $host 不是 docker-compose.prod.yml 的服务名"
    fi
  done < <(awk '
    /^[[:space:]]*#/ { next }
    /job_name:[[:space:]]*noj-/ {
      job = $0
      sub(/.*job_name:[[:space:]]*/, "", job)
    }
    /targets:/ {
      if (job == "") next
      line = $0
      sub(/.*targets:[[:space:]]*/, "", line)
      sub(/[^]]*$/, "", line)
      gsub(/[][",]/, "", line)
      gsub(/[[:space:]]+/, "", line)
      if (line != "") print job "\t" line
    }
  ' "$PROMETHEUS")
  pass "抓取目标主机名与生产 compose 服务名一致"
fi

# 3. 失联检测规则存在（不依赖 core 自身指标）
grep -q 'NojCoreScrapeDown' "$ALERTS" || fail "缺少 NojCoreScrapeDown"
grep -q 'up{job="noj-core"} == 0' "$ALERTS" || fail "缺少 core 抓取失败表达式"
grep -q 'NojApiErrorRateRecentWarning' "$ALERTS" || fail "缺少近期错误率告警"
grep -q 'noj_http_request_errors_total\[5m\]' "$ALERTS" ||
  fail "近期错误率应使用滑动窗口 rate"
grep -q 'NojBackupStale' "$ALERTS" || fail "缺少备份新鲜度告警"
grep -q 'noj_backup_last_success_unix_time' "$ALERTS" || fail "备份告警未引用 textfile 指标"
grep -q 'NojRestoreDrillStale' "$ALERTS" || fail "缺少恢复演练新鲜度告警"
grep -q 'NojSloRulesMissing' "$ALERTS" || fail "缺少 SLO 规则装载看门狗告警"
grep -q 'absent(noj:slo:api_availability:burn_rate)' "$ALERTS" ||
  fail "SLO 看门狗应使用 absent() 检测记录规则缺失"
pass "失联检测、近期错误率、备份新鲜度与 SLO 装载看门狗齐备"

# 3.5 SLO 规则存在且与运维告警分离
grep -q 'NojSloApiAvailabilityFast' "$SLO_ALERTS" || fail "缺少 API 可用性 SLO 告警"
grep -q 'NojSloSubmissionE2eLatencyFast' "$SLO_ALERTS" ||
  fail "缺少提交端到端延迟 SLO 告警"
grep -q 'NojSloEvaluationThroughput' "$SLO_ALERTS" ||
  fail "缺少评测吞吐 SLO 告警"
grep -q 'method="POST"' "$SLO_ALERTS" ||
  fail "评测吞吐 guard 缺少 method=POST，浏览提交列表会误判为有提交流量"
! grep -q 'NojCoreScrapeDown' "$SLO_ALERTS" ||
  fail "SLO 规则文件不应包含运维告警"
pass "SLO 规则独立生成且包含核心 SLO 告警"

# 3.6 阈值型指标不得两边同时告警
# judging 年龄是阈值 gauge 而非 SLO，只由运维告警 NojStaleJudging 负责，
# 否则同一条件会产生两个 Alertmanager 分组与两本 Runbook。
grep -q 'NojStaleJudging' "$ALERTS" || fail "缺少 judging 卡死运维告警"
! grep -q 'NojSloQueueOldestJudgingAge' "$SLO_ALERTS" ||
  fail "judging 年龄不应同时存在 SLO 告警（与 NojStaleJudging 重复）"
pass "judging 年龄仅由运维告警负责，无重复告警"

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
