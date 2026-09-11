/**
 * 观测域内部聚合类型。
 *
 * 本类型只服务于 `/metrics` 渲染，不构成对外 JSON 契约：
 * 管理端观测端点已移除，展示归 Prometheus / Grafana。
 */

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

export interface MetricsSnapshot {
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
  judge: JudgeSnapshot;
  providers?: {
    name: string;
    status: "ok" | "error" | "timeout";
    duration_ms: number;
    error?: string;
  }[];
}
