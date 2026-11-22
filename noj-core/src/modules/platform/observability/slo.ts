/**
 * SLO 定义单一事实源。
 *
 * 告警规则由 scripts/gen-alert-rules.ts 从本文件生成到
 * deploy/monitoring/noj-slo-alerts.yml；运维告警保留在
 * deploy/monitoring/noj-alerts.yml，二者由 Prometheus 分别加载。
 *
 * 约定：
 * - `kind: "ratio"`：SLI 为 0..1 的可用性/达标率，使用 burn-rate 公式。
 * - `kind: "threshold"`：SLI 为瞬时值，超过/低于 objective 即视为违规。
 */

export type SloSeverity = "warning" | "critical";

interface SloBase {
  id: string;
  title: string;
  /** PromQL：ratio 模式返回 0..1；threshold 模式返回被监控的瞬时值。 */
  sli: string;
  runbook: string;
  severity: SloSeverity;
}

export interface RatioSloDefinition extends SloBase {
  kind: "ratio";
  /** 目标值，0..1。 */
  objective: number;
  /**
   * 快/慢两条规则各自的 `for:` 保持时长（不是 MWMBR 的两个评估窗口）。
   *
   * 当前实现是**单窗口**燃烧率：SLI 表达式内的窗口在 `sli` 里写死（多数为
   * `[5m]`），两条规则使用完全相同的表达式与阈值，`slow` 仅作为更长的保持时长。
   * 因此 `burn_rate > 1` 在代数上等价于 `SLI < objective`（在 `sli` 的窗口内），
   * 而 `fast` 被 `slow` 严格蕴含——长事故会同时触发 Error 与 Warning。
   *
   * 计算实际触发敏感度时请用 `sli` 里写的窗口，而不是这里的长窗口：例如
   * `api_availability` 的 objective 为 0.995，意味着 5 分钟内 5xx 比例超过
   * 0.5% 即触发 critical，而非 SRE workbook 中 30 天错误预算口径的页出阈值。
   *
   * 真正的多窗口多燃烧率（MWMBR）需要长/短窗口同时越限，属后续工作。
   */
  holdFor: { long: string; short: string };
}

export interface ThresholdSloDefinition extends SloBase {
  kind: "threshold";
  /** 阈值；与 `comparison` 组合判断是否违规。 */
  objective: number;
  comparison: ">" | "<";
  forDuration: string;
  /** 可选：只有 guard 为真时才告警，避免无流量时误报。 */
  guard?: string;
}

export type SloDefinition = RatioSloDefinition | ThresholdSloDefinition;

export const SLOS: readonly SloDefinition[] = [
  {
    id: "api_availability",
    kind: "ratio",
    title: "核心 API 可用性",
    sli:
      'sum(rate(noj_http_requests_total{status!~"5.."}[5m])) / sum(rate(noj_http_requests_total[5m]))',
    objective: 0.995,
    holdFor: { long: "1h", short: "5m" },
    severity: "critical",
    runbook: "deploy/monitoring/runbooks/api-availability.md",
  },
  {
    id: "submission_e2e_latency",
    kind: "ratio",
    title: "提交端到端延迟",
    // 5 秒内完成首次评测的比例；histogram bucket 由 submission 域默认桶提供。
    sli:
      'sum(rate(noj_submission_e2e_duration_seconds_bucket{le="5"}[5m])) / sum(rate(noj_submission_e2e_duration_seconds_count[5m]))',
    objective: 0.95,
    holdFor: { long: "1h", short: "5m" },
    severity: "critical",
    runbook: "deploy/monitoring/runbooks/submission-e2e-latency.md",
  },
  {
    id: "evaluation_throughput",
    kind: "threshold",
    title: "评测吞吐",
    // 评测结果速率低于 0.1/s；仅在有提交流量时告警，避免夜间空跑误报。
    // guard 必须带 method="POST"：http-metrics 记录所有方法，缺少该过滤时用户浏览
    // 提交列表就会让 guard 为真。目标为绝对阈值，低流量窗口下正常触发（见 runbook）。
    sli: "sum(rate(noj_evaluation_results_total[5m]))",
    objective: 0.1,
    comparison: "<",
    forDuration: "10m",
    severity: "warning",
    guard:
      'sum(rate(noj_http_requests_total{method="POST",route=~"/api/v1/submissions.*"}[5m])) > 0',
    runbook: "deploy/monitoring/runbooks/evaluation-throughput.md",
  },
];
