/**
 * Judge TTL 心跳协议与聚合（core 侧）。
 *
 * Rust judge 每 10s 写入 Redis key，TTL 30s；core 通过 SCAN 聚合。
 */

import { getRedis } from "../../../shared/mq/connection.ts";
import type { ObservabilityRegistry } from "../../../shared/observability/contracts.ts";
import type { JudgeSnapshot } from "../types.ts";

const JUDGE_HEARTBEAT_PREFIX = "noj:observability:judge:";

interface JudgeHeartbeat {
  schema_version?: number;
  /** Judge Worker 自身版本号（来自 Cargo.toml，P1d 起写入心跳）。 */
  judge_version?: string;
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
  scheduling_version?: number;
  resource_group?: string;
  resource_pools?: string[];
  resources?: { capacities?: Record<string, number> };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/** 空心跳快照；Redis 不可用或没有 worker 在线时作为降级值。 */
export function emptyJudgeSnapshot(): JudgeSnapshot {
  return {
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
}

/** 单个 Judge Worker 的心跳报告（逐节点展示用的最小投影）。 */
export interface JudgeNodeReport {
  /** 实例标识，来自 Redis key 的 `noj:observability:judge:<instance_id>` 后缀。 */
  instance_id: string;
  /** Judge Worker 版本号；旧版本心跳无该字段。 */
  judge_version?: string;
  /** 调度协议版本；v1 起携带资源池容量信息。 */
  scheduling_version?: number;
  /** 共享硬件资源组名（v1 起）。 */
  resource_group?: string;
  /** 当前活跃任务数。 */
  active_tasks: number;
  /** 最大并发任务数。 */
  max_concurrent_tasks: number;
  /** 心跳写入时间（毫秒时间戳）。 */
  updated_at_ms?: number;
}

/**
 * 逐节点读取 Judge Worker 心跳报告（不聚合）。
 *
 * 与 `readJudgeHeartbeats` 共用 key 前缀与容错口径：SCAN 上限 1000，
 * malformed 心跳忽略；结果按 instance_id 排序，保证同一批心跳输出稳定。
 *
 * 仅由组合根（app.ts）注入给排空状态服务——system 域不得直接 import
 * observability 域（域边界门禁）。
 *
 * @param redis 已就绪的 Redis 连接
 * @returns 逐节点心跳报告（无 worker 时为空数组）
 */
export async function readJudgeNodeReports(
  redis: ReturnType<typeof getRedis>,
): Promise<JudgeNodeReport[]> {
  const reports: JudgeNodeReport[] = [];
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
        reports.push({
          instance_id: key.slice(JUDGE_HEARTBEAT_PREFIX.length),
          ...(typeof hb.judge_version === "string" && hb.judge_version
            ? { judge_version: hb.judge_version }
            : {}),
          ...(typeof hb.scheduling_version === "number"
            ? { scheduling_version: hb.scheduling_version }
            : {}),
          ...(typeof hb.resource_group === "string"
            ? { resource_group: hb.resource_group }
            : {}),
          active_tasks: numberOrZero(hb.active_tasks),
          max_concurrent_tasks: numberOrZero(hb.max_concurrent_tasks),
          ...(typeof hb.updated_at_ms === "number"
            ? { updated_at_ms: hb.updated_at_ms }
            : {}),
        });
      } catch {
        // malformed 心跳忽略（与聚合读取同口径）
      }
    }
    if (scanned > 1000) break;
  } while (cursor !== "0");
  return reports.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
}

export async function readJudgeHeartbeats(
  redis: ReturnType<typeof getRedis>,
): Promise<JudgeSnapshot> {
  const aggregate = emptyJudgeSnapshot();
  let cursor = "0";
  let scanned = 0;
  const groupCapacities = new Map<
    string,
    { capacities: Record<string, number>; pools: Set<string> }
  >();
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
        if (
          hb.scheduling_version === 1 &&
          typeof hb.resource_group === "string" && hb.resources?.capacities
        ) {
          const group = groupCapacities.get(hb.resource_group) ??
            { capacities: hb.resources.capacities, pools: new Set<string>() };
          for (const pool of hb.resource_pools ?? []) group.pools.add(pool);
          groupCapacities.set(hb.resource_group, group);
        } else {aggregate.max_concurrent_tasks += numberOrZero(
            hb.max_concurrent_tasks,
          );}
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
  for (const group of groupCapacities.values()) {
    for (
      const [pool, key] of [["oi-wasm", "wasm_tasks"], [
        "oi-native",
        "native_tasks",
      ], ["ai", "ai_tasks"]]
    ) {
      if (group.pools.has(pool)) {
        aggregate.max_concurrent_tasks += numberOrZero(group.capacities[key]);
      }
    }
  }
  return aggregate;
}

/**
 * 注册 Judge 心跳 snapshot provider。
 *
 * 由 app.ts 组合根调用；观测域不 import 业务域。
 */
export function registerJudgeHeartbeatProvider(
  registry: ObservabilityRegistry,
): void {
  registry.registerSnapshotProvider({
    name: "judge.heartbeat",
    timeoutMs: 500,
    collect: async () => {
      const redis = getRedis();
      // 未连接时不阻塞快照；下一轮抓取会自动恢复。
      if (redis.status !== "ready") {
        return { judge: emptyJudgeSnapshot() };
      }
      return { judge: await readJudgeHeartbeats(redis) };
    },
  });
}
