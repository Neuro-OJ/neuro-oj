/**
 * 观测域读侧类型。
 */

export interface ObservabilityAlert {
  key: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "ok";
  message: string;
}

export interface JudgeSnapshot {
  required: boolean;
  workers: number;
  active_tasks: number;
  max_concurrent_tasks: number;
  completed_tasks_total: number;
  failed_tasks_total: number;
  result_push_failures_total: number;
  orphan_containers: number;
  cache_items: number;
  cache_bytes: number;
  work_dir_bytes: number;
  last_seen_at: string | null;
}

export interface ObservabilitySnapshot {
  generated_at: string;
  dependencies: Record<string, unknown>;
  queue: {
    pending: number | null;
    processing: number | null;
    result_pending: number | null;
    result_processing: number | null;
    judging: number | null;
    oldest_judging_age_seconds: number | null;
  };
  api: {
    requests_total: number;
    errors_total: number;
    rate_limited_total: number;
    error_rate_percent: number;
    average_latency_ms: number | null;
  };
  judge: JudgeSnapshot;
  alerts: ObservabilityAlert[];
  providers?: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[];
}
