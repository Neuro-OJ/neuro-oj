// 待调度队列读取：pending 队列的任务/标识/长度/位置/快照与资源等待原因判定。
import { getRedis } from "../../../../shared/mq/connection.ts";
import {
  ALL_JUDGE_QUEUES,
  JUDGE_POOL_QUEUES,
  JUDGE_QUEUE_LAYOUT,
  JUDGE_QUEUES,
  JUDGE_RESOURCE_POOLS,
  type JudgeQueuePool,
} from "../../../../shared/mq/judge-queues.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "submission"]);

/** 评测任务队列名称列表（与 producer.ts 一致，按优先级排列）。 */
export const JUDGE_QUEUE_LIST = ALL_JUDGE_QUEUES;

/** 监控/列表路径默认只读取的 pending 条目数；超过时为保证正确性回退全量 LRANGE。 */
export const PENDING_LIST_LIMIT = 1000;

/**
 * 从 Redis 获取 pending 队列中的 submission_id 列表（按入队顺序）。
 *
 * `limit` 是**跨三级队列的总上限**：旧实现把 limit 分别应用到每个队列，
 * 调用方要 20 条却可能拿到 60 条。
 */
export interface PendingSchedulingTask {
  submission_id: string;
  resource_pool?: JudgeQueuePool;
  run_id?: string;
  rejudge_seq?: number;
}

/** 等待诊断只有匹配当前评测轮次时才显示，拒绝任意 Worker 字段。 */
export function matchingResourceWaitReason(
  task: { run_id?: string; rejudge_seq?: number },
  value: unknown,
): "user_busy" | "memory" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const waiting = value as Record<string, unknown>;
  if (
    waiting.run_id !== (task.run_id ?? null) ||
    waiting.rejudge_seq !== (task.rejudge_seq ?? 0)
  ) return null;
  return waiting.reason === "user_busy" || waiting.reason === "memory"
    ? waiting.reason
    : null;
}
export async function getPendingSchedulingTasks(
  limit: number,
): Promise<PendingSchedulingTask[]> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  // NOJ-077：监控/列表路径默认不全量 LRANGE；limit<=0 时仍允许调用方按需取全量。
  const unlimited = limit <= 0;
  const raw: string[] = [];
  for (const queue of JUDGE_QUEUE_LIST) {
    if (!unlimited && raw.length >= limit) break;
    const end = unlimited ? -1 : Math.max(0, limit - raw.length - 1);
    raw.push(...await redis.lrange(queue, 0, end));
  }
  const tasks: PendingSchedulingTask[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item);
      if (typeof parsed.submission_id === "string") {
        tasks.push({
          submission_id: parsed.submission_id,
          ...(JUDGE_RESOURCE_POOLS.includes(parsed.resource_pool)
            ? { resource_pool: parsed.resource_pool }
            : {}),
          ...(typeof parsed.run_id === "string"
            ? { run_id: parsed.run_id }
            : {}),
          ...(Number.isSafeInteger(parsed.rejudge_seq)
            ? { rejudge_seq: parsed.rejudge_seq }
            : {}),
        });
      }
    } catch {
      logger.error("队列中存在无法解析的条目，已跳过");
    }
  }
  return tasks;
}

/** 从各池队列提取提交标识；源码和测试包不进入响应。 */
export async function getPendingSubmissionIds(
  limit = PENDING_LIST_LIMIT,
): Promise<string[]> {
  return (await getPendingSchedulingTasks(limit)).map((task) =>
    task.submission_id
  );
}

/** 获取 pending 队列实际长度（O(1)）。 */
export async function getPendingQueueLength(): Promise<number> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  const lengths = await Promise.all(
    JUDGE_QUEUE_LIST.map((queue) => redis.llen(queue)),
  );
  return lengths.reduce((total, value) => total + Number(value ?? 0), 0);
}

/**
 * 计算提交在三级队列中的排队位置。
 *
 * 消费顺序为 high → medium → low，同一队列内 LRANGE 尾部（更早入队）先出队：
 * - `position`：按上述顺序估算的前方任务数 + 1（1 = 下一个出队）；
 * - `queueLength`：三级队列总长度；
 * - `position` 为 null 表示该提交不在任何主队列（可能正在评测或已出队）。
 */
export async function getPendingQueuePosition(
  submissionId: string,
): Promise<{ position: number | null; queueLength: number }> {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  const groups = JUDGE_QUEUE_LAYOUT === "legacy"
    ? [Object.values(JUDGE_QUEUES)]
    : JUDGE_RESOURCE_POOLS.map((pool) =>
      Object.values(JUDGE_POOL_QUEUES[pool])
    );
  for (const queues of groups) {
    const lengths = await Promise.all(queues.map((queue) => redis.llen(queue)));
    let ahead = 0;
    for (let index = 0; index < queues.length; index++) {
      if (!Number(lengths[index])) continue;
      const items = await redis.lrange(queues[index], 0, -1);
      const found = items.findIndex((raw) => {
        try {
          return JSON.parse(raw).submission_id === submissionId;
        } catch {
          return false;
        }
      });
      if (found !== -1) {
        return {
          position: ahead + items.length - found,
          queueLength: lengths.reduce(
            (total, length) => total + Number(length ?? 0),
            0,
          ),
        };
      }
      ahead += Number(lengths[index] ?? 0);
    }
  }
  return { position: null, queueLength: 0 };
}

/**
 * 获取 pending 队列快照。
 *
 * 队列长度不超过 PENDING_LIST_LIMIT 时走限量 LRANGE；
 * 超过时回退全量 LRANGE，保证队列位置与 judging 排除逻辑在积压场景下仍正确。
 */
export async function getPendingQueueSnapshot(): Promise<{
  ids: string[];
  length: number;
  scheduling: Map<string, PendingSchedulingTask>;
}> {
  const length = await getPendingQueueLength();
  const tasks = await getPendingSchedulingTasks(
    length > PENDING_LIST_LIMIT ? -1 : PENDING_LIST_LIMIT,
  );
  return {
    ids: tasks.map((task) => task.submission_id),
    length,
    scheduling: new Map(tasks.map((task) => [task.submission_id, task])),
  };
}
