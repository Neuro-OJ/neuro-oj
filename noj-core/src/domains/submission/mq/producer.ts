import type { JudgeTask, JudgeTaskPriority } from "../types/index.ts";
import { getRedis } from "../../../shared/mq/connection.ts";
import {
  JUDGE_POOL_QUEUES,
  JUDGE_QUEUE_LAYOUT,
  JUDGE_QUEUE_PREFIX,
  JUDGE_QUEUES,
  JUDGE_RESOURCE_POOLS,
  judgeQueueFor,
} from "../../../shared/mq/judge-queues.ts";
import { getLogger } from "@logtape/logtape";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { selfTests, submissions } from "../../../shared/db/schema.ts";

const logger = getLogger(["noj", "submission"]);

export { JUDGE_QUEUE_PREFIX, JUDGE_QUEUES };
export { ALL_JUDGE_QUEUES } from "../../../shared/mq/judge-queues.ts";

/**
 * 每级评测队列最大待评测数：超过后拒绝新提交，避免 Redis 内存无限增长。
 */
export const JUDGE_QUEUE_CAPACITY: Record<JudgeTaskPriority, number> = {
  high: 5000,
  medium: 10000,
  low: 20000,
};

/**
 * Redis 队列消息最大字节数。
 *
 * 留出充足冗余以避免在 Redis 集群环境下触达单值上限（默认 512MB），
 * 同时阻止用户提交的 base64 编码支持包 + 代码占用过多内存。
 */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // 16MB

/**
 * 原子执行“容量检查 + 入队”，避免 LLEN 与 LPUSH 之间的竞态窗口。
 * 返回 LPUSH 后的真实队列长度；容量已满时返回 -1。
 */
const QUEUE_CAPACITY_SCRIPT = `
local current = 0
for _, key in ipairs(KEYS) do current = current + redis.call("LLEN", key) end
local max = tonumber(ARGV[1])
if current >= max then
  return -1
end
return redis.call("LPUSH", KEYS[1], ARGV[2])
`;

/**
 * 判断评测任务入队失败是否可重试。
 *
 * 只有明确已知的永久错误（如消息超过大小限制）返回 false；
 * Redis 不可用、队列已满以及未知错误都按可恢复处理，避免把瞬时故障误判为永久失败。
 */
export function isRetryableJudgeQueueError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("超过大小限制")) return false;
  return true;
}

/**
 * 将评测任务推送到对应优先级的 Redis 消息队列。
 * 使用 LPUSH 将任务添加到队列头部，noj-judge 通过 BRPOPLPUSH 消费。
 *
 * @param task - 评测任务（必须携带服务端推导的 priority）
 * @returns 队列长度（LPUSH 返回值）
 * @throws 如果 Redis 连接不可用、消息超过大小限制或对应队列已满
 */
export async function pushJudgeTask(task: JudgeTask): Promise<number> {
  const redis = getRedis();

  // 显式检查连接状态，确保断开时立即抛错
  if (redis.status !== "ready") {
    throw new Error(
      `Redis 连接不可用（状态: ${redis.status}），无法推送评测任务`,
    );
  }
  if (
    JUDGE_QUEUE_LAYOUT === "legacy" &&
    await redis.get(`${JUDGE_QUEUE_PREFIX}:layout`) === "pools"
  ) {
    throw new Error("评测队列已升级为资源池布局，请协调升级 Core 配置后重试");
  }

  const message = JSON.stringify(task);

  // 序列化后字节数校验（Redis 单值上限 512MB，留 16MB 上限以保护 worker 内存）
  const messageBytes = new TextEncoder().encode(message).length;
  if (messageBytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `评测任务消息超过大小限制（${messageBytes} > ${MAX_MESSAGE_BYTES} 字节），请检查支持包大小`,
    );
  }

  const queue = judgeQueueFor(task.resource_pool, task.priority);
  const capacityQueues = JUDGE_QUEUE_LAYOUT === "legacy" ? [queue] : [
    queue,
    ...JUDGE_RESOURCE_POOLS
      .filter((pool) => pool !== task.resource_pool).map((pool) =>
        JUDGE_POOL_QUEUES[pool][task.priority]
      ),
  ];
  const capacity = JUDGE_QUEUE_CAPACITY[task.priority];
  if (task.run_id) {
    const db = getDb();
    const initial = {
      sequence: 0,
      phase: "queued",
      active_cases: [],
      completed_cases: [],
      total_cases: "subtasks" in task.runtime_config
        ? task.runtime_config.subtasks.reduce(
          (sum, subtask) => sum + subtask.cases.length,
          0,
        )
        : 0,
    };
    if (task.submission_id.startsWith("st_")) {
      await db.update(selfTests).set({
        judge_run_id: task.run_id,
        judge_progress: initial,
      }).where(
        and(
          eq(selfTests.id, task.submission_id),
          inArray(selfTests.status, ["pending", "judging"]),
        ),
      );
    } else {
      await db.update(submissions).set({
        judge_run_id: task.run_id,
        judge_progress: initial,
      }).where(
        and(
          eq(submissions.id, task.submission_id),
          eq(submissions.rejudge_seq, task.rejudge_seq ?? 0),
          inArray(submissions.status, ["pending", "judging"]),
        ),
      );
    }
  }

  // NOJ-077：用单条 Lua 脚本原子完成容量检查和入队，拒绝而不是静默丢最老任务。
  const length = await redis.eval(
    QUEUE_CAPACITY_SCRIPT,
    capacityQueues.length,
    ...capacityQueues,
    capacity,
    message,
  );
  if (length < 0) {
    throw new Error(
      `评测队列已满（${capacity}/${capacity}），请稍后重试`,
    );
  }

  // 注意：不要对主队列设置 EXPIRE。Redis 列表在变为空时会自动删除 key；
  // 对非空列表设置 TTL 会在队列积压且没有新提交时把整个队列（含未消费任务）一起删掉。
  logger.info("评测任务入队", {
    submission_id: task.submission_id,
    queue_length: length,
    size_bytes: messageBytes,
  });
  return length;
}
