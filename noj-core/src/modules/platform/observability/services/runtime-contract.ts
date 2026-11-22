/**
 * 外部运行时接入契约。
 *
 * gateway 走 HTTP 模式（Prometheus 直抓指标）；judge 是纯 Worker，没有 HTTP
 * 端点，固定走 heartbeat 模式（由心跳聚合出指标）。
 * gateway 地址可由 RUNTIME_LLM_GATEWAY_URL 覆盖。
 */

export interface RuntimeDescriptor {
  name: "noj-llm-gateway" | "noj-judge";
  contractVersion: 1;
  mode: "http" | "heartbeat";
  healthUrl?: string;
  metricsUrl?: string;
  heartbeatKey?: string;
  requiredMetrics: readonly string[];
}

function gatewayBaseUrl(): string {
  return (Deno.env.get("RUNTIME_LLM_GATEWAY_URL") ??
    "http://noj-llm-gateway:8001")
    .replace(/\/+$/, "");
}

export const RUNTIME_DESCRIPTORS: readonly RuntimeDescriptor[] = [
  {
    name: "noj-llm-gateway",
    contractVersion: 1,
    mode: "http",
    healthUrl: `${gatewayBaseUrl()}/health/live`,
    metricsUrl: `${gatewayBaseUrl()}/metrics`,
    requiredMetrics: [
      "noj_llm_requests_total",
      "noj_llm_request_duration_seconds",
      "noj_llm_tokens_total",
      "noj_llm_rate_limited_total",
      "noj_llm_quota_exhausted_total",
      "noj_llm_provider_errors_total",
    ],
  },
  {
    name: "noj-judge",
    contractVersion: 1,
    mode: "heartbeat",
    heartbeatKey: "noj:observability:judge:",
    requiredMetrics: [
      "noj_judge_workers",
      "noj_judge_active_tasks",
      "noj_judge_completed_tasks_total",
      "noj_judge_failed_tasks_total",
      "noj_judge_result_push_failures_total",
      "noj_judge_orphan_containers",
      "noj_judge_cache_items",
      "noj_judge_cache_bytes",
      "noj_judge_work_dir_bytes",
    ],
  },
];
