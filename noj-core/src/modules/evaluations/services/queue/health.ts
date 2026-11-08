// 队列健康度：单队列健康快照、主队列聚合与健康接口响应。
import { getRedis } from "../../../../shared/mq/connection.ts";
import {
  JUDGE_POOL_QUEUES,
  JUDGE_RESOURCE_POOLS,
  type JudgeQueuePool,
} from "../../../../shared/mq/judge-queues.ts";
import { getLogger } from "@logtape/logtape";
import type {
  QueueHealthEntry,
  QueueHealthResponse,
} from "../../types/queue.ts";
import { JUDGE_QUEUE_LIST } from "./pending.ts";

const logger = getLogger(["noj", "submission"]);

/** 评测结果队列名称（与 consumer.ts 一致）。 */
const RESULT_QUEUE = "noj:judge:results";

/**
 * 从 Redis 读取单个队列（主队列/processing/dead）的健康快照。
 *
 * 用于管理端队列状态页与健康检查。Redis 不可用或任一读取失败时：
 * - 长度字段返回 -1（调用方可据此判定 degraded）；
 * - 不抛出异常，避免健康检查本身把服务打挂。
 *
 * 注意：当前不暴露 processing 中最老消息的“真实年龄”，因为现有消息
 * 负载没有内建时间戳，无法在不扫描/反序列化每条消息的情况下可靠计算。
 * 这里只暴露 O(1) 的长度指标，避免提供误导性数据。
 */
async function readQueueHealth(mainQueue: string): Promise<QueueHealthEntry> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    try {
      await redis.connect();
    } catch {
      return {
        queue_length: -1,
        processing_length: -1,
        dead_length: -1,
      };
    }
  }

  try {
    const [queueLength, processingLength, deadLength] = await Promise.all([
      redis.llen(mainQueue),
      redis.llen(`${mainQueue}:processing`),
      redis.llen(`${mainQueue}:dead`),
    ]);

    return {
      queue_length: Number(queueLength ?? 0),
      processing_length: Number(processingLength ?? 0),
      dead_length: Number(deadLength ?? 0),
    };
  } catch (err) {
    logger.warn("读取队列健康状态失败", { mainQueue, err });
    return {
      queue_length: -1,
      processing_length: -1,
      dead_length: -1,
    };
  }
}

/**
 * 聚合三个评测任务优先级队列的健康快照。
 *
 * 任一队列读取失败（-1）时整体返回 -1，避免把 degraded 状态误报为 0。
 */
async function readJudgeQueueHealth(): Promise<QueueHealthEntry> {
  const entries = await Promise.all(
    JUDGE_QUEUE_LIST.map((queue) => readQueueHealth(queue)),
  );
  const sum = (pick: (e: QueueHealthEntry) => number): number => {
    if (entries.some((e) => pick(e) < 0)) return -1;
    return entries.reduce((total, e) => total + pick(e), 0);
  };
  return {
    queue_length: sum((e) => e.queue_length),
    processing_length: sum((e) => e.processing_length),
    dead_length: sum((e) => e.dead_length),
  };
}

/**
 * 获取评测任务/结果队列的健康状态（管理端/运维用）。
 *
 * Redis 不可用时返回 `redis_ok: false`，各队列长度均为 -1。
 */
export async function getQueueHealth(): Promise<QueueHealthResponse> {
  const redis = getRedis();
  let redisOk = false;
  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    await redis.ping();
    redisOk = true;
  } catch {
    redisOk = false;
  }

  const judge = await readJudgeQueueHealth();
  const result = await readQueueHealth(RESULT_QUEUE);
  const pools = Object.fromEntries(
    await Promise.all(JUDGE_RESOURCE_POOLS.map(async (pool) => {
      const entries = await Promise.all(
        Object.values(JUDGE_POOL_QUEUES[pool]).map(readQueueHealth),
      );
      const sum = (field: keyof QueueHealthEntry) =>
        entries.some((entry) => entry[field] < 0)
          ? -1
          : entries.reduce((total, entry) => total + entry[field], 0);
      return [pool, {
        queue_length: sum("queue_length"),
        processing_length: sum("processing_length"),
        dead_length: sum("dead_length"),
      }];
    })),
  ) as Record<JudgeQueuePool, QueueHealthEntry>;
  const resource_groups: Record<string, Record<string, unknown>> = Object
    .create(null);
  if (redisOk) {
    let cursor = "0";
    let scanned = 0;
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "noj:observability:judge:*",
        "COUNT",
        100,
      );
      cursor = next;
      for (const key of keys) {
        if (++scanned > 1000) break;
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const heartbeat = JSON.parse(raw);
          if (
            heartbeat.scheduling_version !== 1 ||
            typeof heartbeat.resource_group !== "string" || !heartbeat.resources
          ) continue;
          const previous = resource_groups[heartbeat.resource_group];
          const enabled = [
            ...new Set([
              ...(Array.isArray(previous?.resource_pools)
                ? previous.resource_pools
                : []),
              ...(Array.isArray(heartbeat.resource_pools)
                ? heartbeat.resource_pools.filter((pool: unknown) =>
                  JUDGE_RESOURCE_POOLS.includes(pool as JudgeQueuePool)
                )
                : []),
            ]),
          ];
          if (
            !previous ||
            Number(heartbeat.updated_at_ms) >= Number(previous.updated_at_ms)
          ) {
            resource_groups[heartbeat.resource_group] = {
              ...heartbeat.resources,
              updated_at_ms: heartbeat.updated_at_ms,
              scheduling_version: 1,
              resource_pools: enabled,
            };
          } else {
            previous.resource_pools = enabled;
          }
        } catch { /* 无效心跳不影响队列健康读取。 */ }
      }
    } while (cursor !== "0" && scanned <= 1000);
  }
  return {
    judge,
    result,
    pools,
    resource_groups,
    redis_ok: redisOk,
  };
}
