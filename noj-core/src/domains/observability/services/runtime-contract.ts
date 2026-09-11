/**
 * 外部运行时接入契约。
 *
 * gateway/judge 按能力选择 HTTP 或 heartbeat 模式；Prometheus 直抓指标。
 * 地址可由 RUNTIME_LLM_GATEWAY_URL / RUNTIME_JUDGE_MODE 覆盖。
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

function judgeMode(): "http" | "heartbeat" {
  return Deno.env.get("RUNTIME_JUDGE_MODE") === "http" ? "http" : "heartbeat";
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
    mode: judgeMode(),
    healthUrl: judgeMode() === "http"
      ? "http://noj-judge:8002/health/live"
      : undefined,
    metricsUrl: judgeMode() === "http"
      ? "http://noj-judge:8002/metrics"
      : undefined,
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
