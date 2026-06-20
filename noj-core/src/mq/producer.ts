import type { JudgeTask } from "../types/index.ts";
import { getRedis } from "./connection.ts";

/**
 * 评测任务队列名称。
 * noj-judge 从该队列中 BRPOP 拉取任务。
 */
const JUDGE_QUEUE = "noj:judge:queue";

/**
 * 将评测任务推送到 Redis 消息队列。
 * 使用 LPUSH 将任务添加到队列头部，noj-judge 通过 BRPOP 消费。
 *
 * @param task - 评测任务
 * @returns 队列长度（LPUSH 返回值）
 * @throws 如果 Redis 连接不可用
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
  const length = await redis.lpush(JUDGE_QUEUE, message);
  console.log(
    `评测任务已入队: submission_id=${task.submission_id}, 队列长度=${length}`,
  );
  return length;
}
