/**
 * Judge TTL 心跳协议与聚合（core 侧）。
 *
 * Rust judge 每 10s 写入 Redis key，TTL 30s；core 通过 SCAN 聚合。
 */

import { getRedis } from "../../../shared/mq/connection.ts";
import type { ObservabilitySnapshot } from "../types.ts";

const JUDGE_HEARTBEAT_PREFIX = "noj:observability:judge:";

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

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export async function readJudgeHeartbeats(
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
        const hb = JSON.parse(raw) as JudgeHeartbeat;
        aggregate.workers += 1;
        aggregate.active_tasks += numberOrZero(hb.active_tasks);
        aggregate.max_concurrent_tasks += numberOrZero(hb.max_concurrent_tasks);
        aggregate.completed_tasks_total += numberOrZero(
          hb.completed_tasks_total,
        );
        aggregate.failed_tasks_total += numberOrZero(hb.failed_tasks_total);
        aggregate.result_push_failures_total += numberOrZero(
          hb.result_push_failures_total,
        );
        aggregate.orphan_containers += numberOrZero(hb.orphan_containers);
        aggregate.cache_items += numberOrZero(hb.cache_items);
        aggregate.cache_bytes += numberOrZero(hb.cache_bytes);
        aggregate.work_dir_bytes += numberOrZero(hb.work_dir_bytes);
        if (
          hb.updated_at_ms &&
          (!aggregate.last_seen_at ||
            hb.updated_at_ms > Date.parse(aggregate.last_seen_at))
        ) {
          aggregate.last_seen_at = new Date(hb.updated_at_ms).toISOString();
        }
      } catch {
        // malformed 心跳忽略
      }
    }
    if (scanned > 1000) break;
  } while (cursor !== "0");
  return aggregate;
}
