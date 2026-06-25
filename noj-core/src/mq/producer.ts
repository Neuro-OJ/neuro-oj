import type { JudgeTask } from "../types/index.ts";
import { getRedis } from "./connection.ts";
import { logJudgeTaskEnqueued } from "../lib/logging.ts";

/**
 * 评测任务队列名称。
 * noj-judge 从该队列中 BRPOP 拉取任务。
 */
const JUDGE_QUEUE = "noj:judge:queue";

/**
 * Redis 队列消息最大字节数。
 *
 * 留出充足冗余以避免在 Redis 集群环境下触达单值上限（默认 512MB），
 * 同时阻止用户提交的 base64 编码支持包 + 代码占用过多内存。
 */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // 16MB

/**
 * 将评测任务推送到 Redis 消息队列。
 * 使用 LPUSH 将任务添加到队列头部，noj-judge 通过 BRPOP 消费。
 *
 * @param task - 评测任务
 * @returns 队列长度（LPUSH 返回值）
 * @throws 如果 Redis 连接不可用或消息超过大小限制
 */
export async function pushJudgeTask(task: JudgeTask): Promise<number> {
  const redis = getRedis();

  // 显式检查连接状态，确保断开时立即抛错
  if (redis.status !== "ready") {
    throw new Error(
      `Redis 连接不可用（状态: ${redis.status}），无法推送评测任务`,
    );
  }

  const message = JSON.stringify(task);

  // 序列化后字节数校验（Redis 单值上限 512MB，留 16MB 上限以保护 worker 内存）
  const messageBytes = new TextEncoder().encode(message).length;
  if (messageBytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `评测任务消息超过大小限制（${messageBytes} > ${MAX_MESSAGE_BYTES} 字节），请检查支持包大小`,
    );
  }

  const length = await redis.lpush(JUDGE_QUEUE, message);
  logJudgeTaskEnqueued(task.submission_id, length, messageBytes);
  return length;
}
