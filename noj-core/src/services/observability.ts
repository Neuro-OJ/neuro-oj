import { sql } from "drizzle-orm";
import { checkDbHealth, getDb } from "../db/connection.ts";
import { checkRedisHealth, getRedis } from "../mq/connection.ts";
import { consumerAlive } from "../mq/consumer.ts";
import { logger } from "../lib/logging.ts";
import { metrics } from "../lib/metrics.ts";

const JUDGE_HEARTBEAT_PREFIX = "noj:observability:judge:";
const JUDGE_QUEUE = Deno.env.get("JUDGE_QUEUE") || "noj:judge:queue";
const RESULT_QUEUE = Deno.env.get("RESULT_QUEUE") || "noj:judge:results";

export interface ObservabilityAlert {
  key: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "ok";
  message: string;
}

export interface ObservabilitySnapshot {
  generated_at: string;
  dependencies: {
    database: { status: "up" | "down" | "unknown"; latency_ms: number | null };
    redis: { status: "up" | "down" | "unknown"; latency_ms: number | null };
    result_consumer: { status: "up" | "down" | "unknown" };
  };
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
  judge: {
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
  };
  alerts: ObservabilityAlert[];
}

interface JudgeHeartbeat {
  active_tasks?: number;
  max_concurrent_tasks?: number;
  completed_tasks_total?: number;
  failed_tasks_total?: number;
  result_push_failures_total?: number;
  orphan_containers?: number;
  cache_items?: number;
  cache_bytes?: number;
  work_dir_bytes?: number;
  updated_at_ms?: number;
}

interface QueueSnapshot {
  pending: number;
  processing: number;
  resultPending: number;
  resultProcessing: number;
  judge: ObservabilitySnapshot["judge"];
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function firstRow<T>(result: T[] | { rows: T[] }): T | undefined {
  return Array.isArray(result) ? result[0] : result.rows[0];
}

function safeStatus(
  ok: boolean,
  initialized: boolean,
): "up" | "down" | "unknown" {
  if (!initialized) return "unknown";
  return ok ? "up" : "down";
}

async function readJudgeHeartbeats(
  redis: ReturnType<typeof getRedis>,
): Promise<ObservabilitySnapshot["judge"]> {
  const aggregate: ObservabilitySnapshot["judge"] = {
    required: Deno.env.get("NOJ_ENV") === "production" &&
      Deno.env.get("JUDGE_ENABLED") !== "false",
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
  };

  let cursor = "0";
  let scanned = 0;
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${JUDGE_HEARTBEAT_PREFIX}*`,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    for (const key of keys) {
      if (++scanned > 1000) break;
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const heartbeat = JSON.parse(raw) as JudgeHeartbeat;
        aggregate.workers += 1;
        aggregate.active_tasks += numberOrZero(heartbeat.active_tasks);
        aggregate.max_concurrent_tasks += numberOrZero(
          heartbeat.max_concurrent_tasks,
        );
        aggregate.completed_tasks_total += numberOrZero(
          heartbeat.completed_tasks_total,
        );
        aggregate.failed_tasks_total += numberOrZero(
          heartbeat.failed_tasks_total,
        );
        aggregate.result_push_failures_total += numberOrZero(
          heartbeat.result_push_failures_total,
        );
        aggregate.orphan_containers += numberOrZero(
          heartbeat.orphan_containers,
        );
        aggregate.cache_items += numberOrZero(heartbeat.cache_items);
        aggregate.cache_bytes += numberOrZero(heartbeat.cache_bytes);
        aggregate.work_dir_bytes += numberOrZero(heartbeat.work_dir_bytes);
        if (
          heartbeat.updated_at_ms && (!aggregate.last_seen_at ||
            heartbeat.updated_at_ms > Date.parse(aggregate.last_seen_at))
        ) {
          aggregate.last_seen_at = new Date(heartbeat.updated_at_ms)
            .toISOString();
        }
      } catch {
        logger.warn("忽略格式错误的 Judge 观测心跳", { key });
      }
    }
    if (scanned > 1000) break;
  } while (cursor !== "0");

  return aggregate;
}

async function readQueueSnapshot(): Promise<QueueSnapshot | null> {
  const redis = getRedis();
  if (redis.status !== "ready") return null;
  const [pending, processing, resultPending, resultProcessing, judge] =
    await Promise.all([
      redis.llen(JUDGE_QUEUE),
      redis.llen(`${JUDGE_QUEUE}:processing`),
      redis.llen(RESULT_QUEUE),
      redis.llen(`${RESULT_QUEUE}:processing`),
      readJudgeHeartbeats(redis),
    ]);
  return { pending, processing, resultPending, resultProcessing, judge };
}

async function readDatabaseQueueStats(): Promise<
  {
    judging: number;
    oldestJudgingAgeSeconds: number | null;
  } | null
> {
  try {
    const row = firstRow(
      await getDb().execute<{
        judging: string;
        oldest_judging_at: string | null;
      }>(sql`
      SELECT
        count(*) FILTER (WHERE status = 'judging')::text AS judging,
        min(judge_started_at) FILTER (WHERE status = 'judging') AS oldest_judging_at
      FROM submissions
    `),
    );
    const oldest = row?.oldest_judging_at
      ? Date.parse(row.oldest_judging_at)
      : NaN;
    return {
      judging: Number(row?.judging ?? 0),
      oldestJudgingAgeSeconds: Number.isFinite(oldest)
        ? Math.max(0, Math.floor((Date.now() - oldest) / 1000))
        : null,
    };
  } catch (err) {
    logger.warn("获取观测数据库统计失败", { err });
    return null;
  }
}

function makeAlerts(
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

  add(
    "database_unavailable",
    "critical",
    snapshot.dependencies.database.status !== "up",
    "PostgreSQL 不可用",
  );
  add(
    "redis_unavailable",
    "critical",
    snapshot.dependencies.redis.status !== "up",
    "Redis 不可用",
  );
  add(
    "result_consumer_down",
    "critical",
    snapshot.dependencies.result_consumer.status !== "up",
    "评测结果消费者未运行",
  );
  add(
    "judge_workers_down",
    "critical",
    snapshot.judge.required && snapshot.judge.workers === 0,
    "没有在线 Judge Worker",
  );
  add(
    "queue_backlog",
    snapshot.queue.pending !== null && snapshot.queue.pending >= 500
      ? "critical"
      : "warning",
    snapshot.queue.pending !== null && snapshot.queue.pending >= 100,
    "评测 pending 队列持续堆积",
  );
  add(
    "result_backlog",
    "warning",
    snapshot.queue.result_processing !== null &&
      snapshot.queue.result_processing >= 10,
    "评测结果 processing 队列存在积压",
  );
  add(
    "stale_judging",
    "warning",
    snapshot.queue.oldest_judging_age_seconds !== null &&
      snapshot.queue.oldest_judging_age_seconds >= 600,
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
    snapshot.judge.work_dir_bytes >= 8 * 1024 ** 3,
    "Judge 工作目录占用超过 8 GiB",
  );
  return alerts;
}

export async function getObservabilitySnapshot(): Promise<
  ObservabilitySnapshot
> {
  const generatedAt = new Date().toISOString();
  const [dbResult, redisResult] = await Promise.all([
    (async () => {
      const started = performance.now();
      return {
        health: await checkDbHealth(),
        latency_ms: Math.round(performance.now() - started),
      };
    })(),
    (async () => {
      const started = performance.now();
      return {
        health: await checkRedisHealth(),
        latency_ms: Math.round(performance.now() - started),
      };
    })(),
  ]);
  const { health: dbHealth } = dbResult;
  const { health: redisHealth } = redisResult;
  const database = {
    status: safeStatus(dbHealth.ok, true),
    latency_ms: dbResult.latency_ms,
  } as const;
  const redis = {
    status: safeStatus(redisHealth.ok, true),
    latency_ms: redisResult.latency_ms,
  } as const;

  const [queue, databaseQueue] = await Promise.all([
    redisHealth.ok
      ? readQueueSnapshot().catch((err) => {
        logger.warn("获取观测 Redis 统计失败", { err });
        return null;
      })
      : Promise.resolve(null),
    dbHealth.ok ? readDatabaseQueueStats() : Promise.resolve(null),
  ]);
  const requests = metrics.sum("noj_http_requests_total");
  const errors = metrics.sum("noj_http_request_errors_total");
  const latencySumSeconds = metrics.sum("noj_http_request_duration_seconds");
  const requestSamples = metrics.count("noj_http_request_duration_seconds");
  const base = {
    generated_at: generatedAt,
    dependencies: {
      database,
      redis,
      result_consumer: {
        status: consumerAlive.value ? "up" as const : "down" as const,
      },
    },
    queue: {
      pending: queue?.pending ?? null,
      processing: queue?.processing ?? null,
      result_pending: queue?.resultPending ?? null,
      result_processing: queue?.resultProcessing ?? null,
      judging: databaseQueue?.judging ?? null,
      oldest_judging_age_seconds: databaseQueue?.oldestJudgingAgeSeconds ??
        null,
    },
    api: {
      requests_total: requests,
      errors_total: errors,
      rate_limited_total: metrics.sum("noj_http_rate_limited_total"),
      error_rate_percent: requests > 0
        ? Math.round((errors / requests) * 10000) / 100
        : 0,
      average_latency_ms: requestSamples > 0
        ? Math.round((latencySumSeconds / requestSamples) * 100000) / 100
        : null,
    },
    judge: queue?.judge ?? {
      required: Deno.env.get("NOJ_ENV") === "production" &&
        Deno.env.get("JUDGE_ENABLED") !== "false",
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
  };
  return { ...base, alerts: makeAlerts(base) };
}

function gauge(name: string, help: string, value: number | null): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value ?? -1}`;
}

/** 生成完整 Prometheus 指标响应；依赖异常时用 -1 表示 unknown。 */
export async function renderPrometheusMetrics(): Promise<string> {
  const snapshot = await getObservabilitySnapshot();
  const lines = [
    metrics.render().trimEnd(),
    gauge(
      "noj_database_up",
      "PostgreSQL 是否可用",
      snapshot.dependencies.database.status === "up" ? 1 : 0,
    ),
    gauge(
      "noj_redis_up",
      "Redis 是否可用",
      snapshot.dependencies.redis.status === "up" ? 1 : 0,
    ),
    gauge(
      "noj_result_consumer_up",
      "评测结果消费者是否存活",
      snapshot.dependencies.result_consumer.status === "up" ? 1 : 0,
    ),
    gauge(
      "noj_queue_pending_jobs",
      "评测 pending 队列长度",
      snapshot.queue.pending,
    ),
    gauge(
      "noj_queue_processing_jobs",
      "评测 processing 队列长度",
      snapshot.queue.processing,
    ),
    gauge(
      "noj_queue_result_pending_jobs",
      "评测结果 pending 队列长度",
      snapshot.queue.result_pending,
    ),
    gauge(
      "noj_queue_result_processing_jobs",
      "评测结果 processing 队列长度",
      snapshot.queue.result_processing,
    ),
    gauge(
      "noj_queue_judging_jobs",
      "数据库中 judging 状态的评测数",
      snapshot.queue.judging,
    ),
    gauge(
      "noj_queue_oldest_judging_age_seconds",
      "最早 judging 评测年龄（秒）",
      snapshot.queue.oldest_judging_age_seconds,
    ),
    gauge(
      "noj_judge_required",
      "生产环境是否要求 Judge Worker",
      snapshot.judge.required ? 1 : 0,
    ),
    gauge("noj_judge_workers", "在线 Judge Worker 数", snapshot.judge.workers),
    gauge(
      "noj_judge_active_tasks",
      "Judge 活跃任务数",
      snapshot.judge.active_tasks,
    ),
    gauge(
      "noj_judge_max_concurrent_tasks",
      "Judge 并发上限总和",
      snapshot.judge.max_concurrent_tasks,
    ),
    gauge(
      "noj_judge_orphan_containers",
      "Judge 孤儿容器数",
      snapshot.judge.orphan_containers,
    ),
    gauge(
      "noj_judge_cache_items",
      "Judge 支持包缓存条目数",
      snapshot.judge.cache_items,
    ),
    gauge(
      "noj_judge_cache_bytes",
      "Judge 支持包缓存字节数",
      snapshot.judge.cache_bytes,
    ),
    gauge(
      "noj_judge_work_dir_bytes",
      "Judge 工作目录字节数",
      snapshot.judge.work_dir_bytes,
    ),
    gauge(
      "noj_api_error_rate_percent",
      "API 5xx 错误率百分比",
      snapshot.api.error_rate_percent,
    ),
    gauge(
      "noj_api_average_latency_ms",
      "API 平均延迟（毫秒）",
      snapshot.api.average_latency_ms,
    ),
    gauge(
      "noj_database_health_latency_ms",
      "PostgreSQL 健康检查延迟（毫秒）",
      snapshot.dependencies.database.latency_ms,
    ),
    gauge(
      "noj_redis_health_latency_ms",
      "Redis 健康检查延迟（毫秒）",
      snapshot.dependencies.redis.latency_ms,
    ),
    gauge(
      "noj_database_pool_configured_max",
      "PostgreSQL 配置的连接池上限",
      Number(Deno.env.get("DATABASE_POOL_MAX") || 10),
    ),
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}
