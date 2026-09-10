/**
 * 快照告警规则。
 */

import type { ObservabilityAlert, ObservabilitySnapshot } from "../types.ts";

export function makeAlerts(
  snapshot: Omit<ObservabilitySnapshot, "alerts">,
): ObservabilityAlert[] {
  const alerts: ObservabilityAlert[] = [];
  const add = (
    key: string,
    severity: ObservabilityAlert["severity"],
    active: boolean,
    message: string,
  ) =>
    alerts.push({ key, severity, status: active ? "active" : "ok", message });

  const db = snapshot.dependencies.database as { status?: string } | undefined;
  const redis = snapshot.dependencies.redis as { status?: string } | undefined;
  const consumer = snapshot.dependencies.result_consumer as
    | { status?: string }
    | undefined;
  const judge = snapshot.judge as {
    required?: boolean;
    workers?: number;
    work_dir_bytes?: number;
  };
  const queue = snapshot.queue;

  add(
    "database_unavailable",
    "critical",
    db?.status !== "up",
    "PostgreSQL 不可用",
  );
  add("redis_unavailable", "critical", redis?.status !== "up", "Redis 不可用");
  add(
    "result_consumer_down",
    "critical",
    consumer?.status !== "up",
    "评测结果消费者未运行",
  );
  add(
    "judge_workers_down",
    "critical",
    judge.required === true && (judge.workers ?? 0) === 0,
    "没有在线 Judge Worker",
  );
  add(
    "queue_backlog",
    queue.pending !== null && queue.pending >= 500 ? "critical" : "warning",
    queue.pending !== null && queue.pending >= 100,
    "评测 pending 队列持续堆积",
  );
  add(
    "result_backlog",
    "warning",
    queue.result_processing !== null && queue.result_processing >= 10,
    "评测结果 processing 队列存在积压",
  );
  add(
    "stale_judging",
    "warning",
    queue.oldest_judging_age_seconds !== null &&
      queue.oldest_judging_age_seconds >= 600,
    "存在超过 10 分钟未完成的评测",
  );
  add(
    "api_error_rate",
    snapshot.api.error_rate_percent >= 20 ? "critical" : "warning",
    snapshot.api.requests_total >= 20 && snapshot.api.error_rate_percent >= 5,
    "API 5xx 错误率升高",
  );
  add(
    "judge_work_dir_pressure",
    "warning",
    (judge.work_dir_bytes ?? 0) >= 8 * 1024 ** 3,
    "Judge 工作目录占用超过 8 GiB",
  );
  return alerts;
}
