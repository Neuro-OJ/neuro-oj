import { makeAlerts } from "../services/alerts.ts";
import type { ObservabilitySnapshot } from "../types.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("alerts: 队列积压触发告警", () => {
  const base = {
    generated_at: new Date().toISOString(),
    dependencies: {
      database: { status: "up" },
      redis: { status: "up" },
      result_consumer: { status: "up" },
    },
    queue: {
      pending: 200,
      processing: 0,
      result_pending: 0,
      result_processing: 0,
      judging: 0,
      oldest_judging_age_seconds: null,
    },
    api: {
      requests_total: 0,
      errors_total: 0,
      rate_limited_total: 0,
      error_rate_percent: 0,
      average_latency_ms: null,
    },
    judge: {
      required: false,
      workers: 0,
      active_tasks: 0,
      max_concurrent_tasks: 0,
      completed_tasks_total: 0,
      failed_tasks_total: 0,
      result_push_failures_total: 0,
      orphan_containers: 0,
      cache_items: 0,
      cache_bytes: 0,
      work_dir_bytes: 0,
      last_seen_at: null,
    },
  } as Omit<ObservabilitySnapshot, "alerts">;
  const alerts = makeAlerts(base);
  assert(
    alerts.some((a) => a.key === "queue_backlog" && a.status === "active"),
    "应触发 queue_backlog",
  );
});
