/**
 * 观测快照聚合与 Prometheus 渲染。
 *
 * 设计要点：
 * - 快照 = health probes（关键依赖可用性） + snapshot providers（业务/资源数据）。
 * - Prometheus 指标统一写回 registry 后只 render 一次，避免重复 HELP/TYPE。
 * - 任何 provider/探针失败都降级为部分快照，不抛错。
 */

import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import { collectSnapshot, runHealthProbes } from "../probes/registry.ts";
import { registerPlatformMetrics } from "../metrics/platform.ts";
import { makeAlerts } from "./alerts.ts";
import { emptyJudgeSnapshot } from "./judge-heartbeat.ts";
import type { JudgeSnapshot, ObservabilitySnapshot } from "../types.ts";

const DEFAULT_QUEUE = {
  pending: null,
  processing: null,
  result_pending: null,
  result_processing: null,
  judging: null,
  oldest_judging_age_seconds: null,
} as const;

interface DependencyView {
  status?: string;
  latency_ms?: number | null;
}

interface ApiView {
  requests_total?: number;
  errors_total?: number;
  rate_limited_total?: number;
  error_rate_percent?: number;
  average_latency_ms?: number | null;
}

function dependency(value: unknown): DependencyView | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as DependencyView;
}

/**
 * 汇总 HTTP 指标。
 *
 * histogram 的 `sum/count` 用于计算平均延迟；counter 的 `sum` 为累计请求数。
 */
function computeApiMetrics(registry: ObservabilityRegistry): ApiView {
  const requestsTotal = registry.sum("noj_http_requests_total");
  const errorsTotal = registry.sum("noj_http_request_errors_total");
  const rateLimitedTotal = registry.sum("noj_http_rate_limited_total");
  const latencySumSeconds = registry.sum("noj_http_request_duration_seconds");
  const latencySamples = registry.count("noj_http_request_duration_seconds");
  return {
    requests_total: requestsTotal,
    errors_total: errorsTotal,
    rate_limited_total: rateLimitedTotal,
    error_rate_percent: requestsTotal > 0
      ? Math.round((errorsTotal / requestsTotal) * 10000) / 100
      : 0,
    average_latency_ms: latencySamples > 0
      ? Math.round((latencySumSeconds / latencySamples) * 100000) / 100
      : null,
  };
}

export async function getObservabilitySnapshot(
  registry: ObservabilityRegistry,
): Promise<ObservabilitySnapshot> {
  const generatedAt = new Date().toISOString();
  const [probeResults, partial] = await Promise.all([
    runHealthProbes(registry),
    collectSnapshot(registry),
  ]);

  // 关键依赖探针（database/redis）合并进 dependencies，保证 /metrics 与管理员快照
  // 能看到真实状态；snapshot provider 的 result_consumer 等字段保持不变。
  const dependencies: Record<string, unknown> = {
    ...(partial.dependencies ?? {}),
  };
  for (const name of ["database", "redis"] as const) {
    const probe = probeResults.find((result) => result.name === name);
    if (!probe) continue;
    dependencies[name] = {
      ...(dependency(dependencies[name]) ?? {}),
      status: probe.status,
      latency_ms: probe.latency_ms,
      ...(probe.error ? { error: probe.error } : {}),
    };
  }

  const computedApi: ObservabilitySnapshot["api"] = computeApiMetrics(
    registry,
  ) as ObservabilitySnapshot["api"];
  const providerApi = (partial.api ?? {}) as Partial<
    ObservabilitySnapshot["api"]
  >;
  const queue =
    (partial.queue ?? DEFAULT_QUEUE) as ObservabilitySnapshot["queue"];
  const judge = (partial.judge as JudgeSnapshot | undefined) ??
    emptyJudgeSnapshot();
  const api = {
    ...computedApi,
    ...providerApi,
  } as ObservabilitySnapshot["api"];

  const base = {
    generated_at: generatedAt,
    dependencies,
    queue,
    api,
    judge,
    providers: partial.providers as ObservabilitySnapshot["providers"],
  };
  return { ...base, alerts: makeAlerts(base) };
}

/**
 * 渲染完整 Prometheus 文本。
 *
 * 所有快照指标先 `set` 回 registry，再统一 render，确保每个 metric family
 * 只有一份 HELP/TYPE。
 */
export async function renderPrometheusMetrics(
  registry: ObservabilityRegistry,
): Promise<string> {
  // render 可能被独立调用（测试/工具）；平台指标定义幂等，重复调用安全。
  registerPlatformMetrics(registry);
  const snapshot = await getObservabilitySnapshot(registry);
  const deps = snapshot.dependencies as Record<string, unknown>;
  const database = dependency(deps.database);
  const redis = dependency(deps.redis);
  const consumer = dependency(deps.result_consumer);
  const judge = snapshot.judge;

  const set = (name: string, value: number | null | undefined): void => {
    registry.set(name, value ?? -1);
  };

  set("noj_database_up", database?.status === "up" ? 1 : 0);
  set("noj_redis_up", redis?.status === "up" ? 1 : 0);
  set("noj_result_consumer_up", consumer?.status === "up" ? 1 : 0);
  set("noj_queue_pending_jobs", snapshot.queue.pending);
  set("noj_queue_processing_jobs", snapshot.queue.processing);
  set("noj_queue_result_pending_jobs", snapshot.queue.result_pending);
  set("noj_queue_result_processing_jobs", snapshot.queue.result_processing);
  set("noj_queue_judging_jobs", snapshot.queue.judging);
  set(
    "noj_queue_oldest_judging_age_seconds",
    snapshot.queue.oldest_judging_age_seconds,
  );
  set("noj_judge_required", judge.required ? 1 : 0);
  set("noj_judge_workers", judge.workers);
  set("noj_judge_active_tasks", judge.active_tasks);
  set("noj_judge_max_concurrent_tasks", judge.max_concurrent_tasks);
  set("noj_judge_orphan_containers", judge.orphan_containers);
  set("noj_judge_cache_items", judge.cache_items);
  set("noj_judge_cache_bytes", judge.cache_bytes);
  set("noj_judge_work_dir_bytes", judge.work_dir_bytes);
  set("noj_judge_completed_tasks_total", judge.completed_tasks_total);
  set("noj_judge_failed_tasks_total", judge.failed_tasks_total);
  set("noj_judge_result_push_failures_total", judge.result_push_failures_total);
  set("noj_api_error_rate_percent", snapshot.api.error_rate_percent);
  set("noj_api_average_latency_ms", snapshot.api.average_latency_ms);
  set("noj_database_health_latency_ms", database?.latency_ms);
  set("noj_redis_health_latency_ms", redis?.latency_ms);
  const poolMax = Number(Deno.env.get("DATABASE_POOL_MAX") || 10);
  set(
    "noj_database_pool_configured_max",
    Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
  );

  return registry.render();
}
