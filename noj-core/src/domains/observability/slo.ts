/**
 * SLO 定义单一事实源。
 *
 * 告警规则由 scripts/gen-alert-rules.ts 从本文件生成/校验。
 */

export interface SloDefinition {
  id: string;
  title: string;
  sli: string;
  objective: number;
  window: "30d";
  burnRateWindows: { long: string; short: string };
  runbook: string;
}

export const SLOS: readonly SloDefinition[] = [
  {
    id: "api_availability",
    title: "核心 API 可用性",
    sli:
      'sum(rate(noj_http_requests_total{status!~"5.."}[5m])) / sum(rate(noj_http_requests_total[5m]))',
    objective: 0.995,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/api-availability.md",
  },
  {
    id: "submission_e2e_latency",
    title: "提交端到端延迟",
    sli: "noj_submission_e2e_duration_seconds",
    objective: 0.95,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/submission-e2e-latency.md",
  },
  {
    id: "queue_oldest_pending_age",
    title: "队列最老 pending 年龄",
    sli: "noj_queue_oldest_pending_age_seconds",
    objective: 0.99,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/queue-oldest-pending-age.md",
  },
  {
    id: "result_delivery_latency",
    title: "结果回传延迟",
    sli: "noj_result_delivery_duration_seconds",
    objective: 0.99,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/result-delivery-latency.md",
  },
  {
    id: "evaluation_throughput",
    title: "评测吞吐",
    sli: "noj_evaluation_throughput_total",
    objective: 0.99,
    window: "30d",
    burnRateWindows: { long: "1h", short: "5m" },
    runbook: "deploy/monitoring/runbooks/evaluation-throughput.md",
  },
];
