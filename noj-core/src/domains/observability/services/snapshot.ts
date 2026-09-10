/**
 * 观测快照聚合与 Prometheus 渲染。
 */

import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { collectSnapshot } from "../probes/registry.ts";
import { makeAlerts } from "./alerts.ts";
import type { ObservabilitySnapshot } from "../types.ts";

export async function getObservabilitySnapshot(
  registry: ObservabilityRegistry,
): Promise<ObservabilitySnapshot> {
  const generatedAt = new Date().toISOString();
  const partial = await collectSnapshot(registry);
  const base = {
    generated_at: generatedAt,
    dependencies:
      (partial.dependencies ?? {}) as ObservabilitySnapshot["dependencies"],
    queue: (partial.queue ?? {
      pending: null,
      processing: null,
      result_pending: null,
      result_processing: null,
      judging: null,
      oldest_judging_age_seconds: null,
    }) as ObservabilitySnapshot["queue"],
    api: (partial.api ?? {
      requests_total: registry.sum("noj_http_requests_total"),
      errors_total: registry.sum("noj_http_request_errors_total"),
      rate_limited_total: registry.sum("noj_http_rate_limited_total"),
      error_rate_percent: 0,
      average_latency_ms: null,
    }) as ObservabilitySnapshot["api"],
    judge: (partial.judge ?? {}) as ObservabilitySnapshot["judge"],
    providers: partial.providers as ObservabilitySnapshot["providers"],
  };
  return { ...base, alerts: makeAlerts(base) };
}

export async function renderPrometheusMetrics(
  registry: ObservabilityRegistry,
): Promise<string> {
  const snapshot = await getObservabilitySnapshot(registry);
  const lines = [
    registry.render().trimEnd(),
    `# HELP noj_database_up PostgreSQL 是否可用\n# TYPE noj_database_up gauge\nnoj_database_up ${
      (snapshot.dependencies.database as { status?: string })?.status === "up"
        ? 1
        : 0
    }`,
    `# HELP noj_redis_up Redis 是否可用\n# TYPE noj_redis_up gauge\nnoj_redis_up ${
      (snapshot.dependencies.redis as { status?: string })?.status === "up"
        ? 1
        : 0
    }`,
    `# HELP noj_queue_pending_jobs 评测 pending 队列长度\n# TYPE noj_queue_pending_jobs gauge\nnoj_queue_pending_jobs ${
      snapshot.queue.pending ?? -1
    }`,
    `# HELP noj_queue_processing_jobs 评测 processing 队列长度\n# TYPE noj_queue_processing_jobs gauge\nnoj_queue_processing_jobs ${
      snapshot.queue.processing ?? -1
    }`,
    `# HELP noj_queue_result_pending_jobs 评测结果 pending 队列长度\n# TYPE noj_queue_result_pending_jobs gauge\nnoj_queue_result_pending_jobs ${
      snapshot.queue.result_pending ?? -1
    }`,
    `# HELP noj_queue_result_processing_jobs 评测结果 processing 队列长度\n# TYPE noj_queue_result_processing_jobs gauge\nnoj_queue_result_processing_jobs ${
      snapshot.queue.result_processing ?? -1
    }`,
    `# HELP noj_queue_judging_jobs 数据库中 judging 状态的评测数\n# TYPE noj_queue_judging_jobs gauge\nnoj_queue_judging_jobs ${
      snapshot.queue.judging ?? -1
    }`,
    `# HELP noj_queue_oldest_judging_age_seconds 最早 judging 评测年龄（秒）\n# TYPE noj_queue_oldest_judging_age_seconds gauge\nnoj_queue_oldest_judging_age_seconds ${
      snapshot.queue.oldest_judging_age_seconds ?? -1
    }`,
    `# HELP noj_judge_workers 在线 Judge Worker 数\n# TYPE noj_judge_workers gauge\nnoj_judge_workers ${
      (snapshot.judge as { workers?: number })?.workers ?? 0
    }`,
    `# HELP noj_api_error_rate_percent API 5xx 错误率百分比\n# TYPE noj_api_error_rate_percent gauge\nnoj_api_error_rate_percent ${snapshot.api.error_rate_percent}`,
    `# HELP noj_api_average_latency_ms API 平均延迟（毫秒）\n# TYPE noj_api_average_latency_ms gauge\nnoj_api_average_latency_ms ${
      snapshot.api.average_latency_ms ?? -1
    }`,
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}
