/**
 * 观测域读侧类型。
 */

export interface ObservabilityAlert {
  key: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "ok";
  message: string;
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
  judge: Record<string, unknown>;
  alerts: ObservabilityAlert[];
  providers?: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[];
}
