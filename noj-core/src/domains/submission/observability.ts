/**
 * submission 域观测 provider 注册。
 *
 * 由 app.ts 组合根调用；观测域不 import 本域。
 */

import { sql } from "drizzle-orm";
import type { ObservabilityRegistry } from "../../shared/observability/contracts.ts";
import { getDb } from "../../shared/db/connection.ts";
import { getRedis } from "../../shared/mq/connection.ts";
import { submissions } from "../../shared/db/schema.ts";
import { logger } from "../../shared/base/logging.ts";
import { getQueueHealth } from "./services/queue.ts";
import { consumerAlive } from "./mq/consumer.ts";

interface DatabaseQueueStats {
  judging: number | null;
  oldest_judging_age_seconds: number | null;
}

/**
 * 读取 submissions 表中 judging 数量与最老 judging 年龄。
 *
 * 表所有权在 submission 域，因此由本域 provider 提供；失败时返回 null 表示未知。
 */
async function readDatabaseQueueStats(): Promise<DatabaseQueueStats> {
  try {
    const [row] = await getDb()
      .select({
        judging: sql<
          number
        >`count(*) filter (where ${submissions.status} = 'judging')`,
        oldest_judging_at: sql<
          string | null
        >`min(${submissions.judge_started_at}) filter (where ${submissions.status} = 'judging')`,
      })
      .from(submissions);
    const oldestMs = row?.oldest_judging_at
      ? Date.parse(row.oldest_judging_at)
      : NaN;
    return {
      judging: Number(row?.judging ?? 0),
      oldest_judging_age_seconds: Number.isFinite(oldestMs)
        ? Math.max(0, Math.floor((Date.now() - oldestMs) / 1000))
        : null,
    };
  } catch (err) {
    logger.warn("获取观测数据库队列统计失败", { err });
    return { judging: null, oldest_judging_age_seconds: null };
  }
}

export function registerSubmissionObservability(
  registry: ObservabilityRegistry,
): void {
  registry.registerBusinessMetric({
    name: "noj_submission_e2e_duration_seconds",
    help: "提交端到端耗时（秒；首次评测，不含重测）",
    type: "histogram",
    owner: "submission",
    labels: ["result"],
  });
  // readiness 旧语义要求结果消费者存活；作为 critical probe 重新纳入。
  registry.registerHealthProbe({
    name: "result_consumer",
    critical: true,
    check: () => ({
      status: consumerAlive.value ? "up" : "down",
    }),
  });
  registry.registerSnapshotProvider({
    name: "submission.queue",
    timeoutMs: 500,
    collect: async () => {
      const [q, dbQueue] = await Promise.all([
        (async () => {
          try {
            // Redis 未 ready 时不要触发 connect()（会阻塞并拖慢 /metrics）。
            const redis = getRedis();
            if (redis.status !== "ready") return null;
            return await getQueueHealth();
          } catch {
            return null;
          }
        })(),
        readDatabaseQueueStats(),
      ]);
      const queue = q
        ? {
          pending: q.judge.queue_length,
          processing: q.judge.processing_length,
          result_pending: q.result.queue_length,
          result_processing: q.result.processing_length,
          judging: dbQueue.judging,
          oldest_judging_age_seconds: dbQueue.oldest_judging_age_seconds,
        }
        : {
          pending: -1,
          processing: -1,
          result_pending: -1,
          result_processing: -1,
          judging: dbQueue.judging,
          oldest_judging_age_seconds: dbQueue.oldest_judging_age_seconds,
        };
      return {
        queue,
        dependencies: {
          result_consumer: { status: consumerAlive.value ? "up" : "down" },
        },
        health: {
          queue: q
            ? {
              judge: q.judge,
              result: q.result,
              redis_ok: q.redis_ok,
            }
            : {
              judge: {
                queue_length: -1,
                processing_length: -1,
                dead_length: -1,
              },
              result: {
                queue_length: -1,
                processing_length: -1,
                dead_length: -1,
              },
              redis_ok: false,
            },
        },
      };
    },
  });
}
