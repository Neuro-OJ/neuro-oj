/**
 * Redis MQ 客户端
 *
 * 评测任务队列 Producer。
 */

import Redis from "ioredis";

/** Redis 连接 */
let redis: Redis | null = null;

/** 评测任务队列名称 */
const JUDGE_QUEUE = "noj:judge:queue";

/** 评测任务消息格式 */
export interface JudgeTask {
  submission_id: string;
  problem_id: string;
  language: string;
  code: string;
  file_name: string;
  time_limit_ms: number;
  memory_limit_mb: number;
  judge_image: string;
  judge_command: string;
}

/**
 * 获取 Redis 连接
 */
export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: Deno.env.get("REDIS_HOST") || "localhost",
      port: parseInt(Deno.env.get("REDIS_PORT") || "6379"),
      password: Deno.env.get("REDIS_PASSWORD") || undefined,
    });
  }
  return redis;
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

/**
 * 推送评测任务到队列
 */
export async function pushJudgeTask(task: JudgeTask): Promise<void> {
  const r = getRedis();
  await r.lpush(JUDGE_QUEUE, JSON.stringify(task));
  console.log(`[MQ] Pushed judge task: ${task.submission_id}`);
}

/**
 * 从队列拉取评测任务（阻塞）
 */
export async function popJudgeTask(): Promise<JudgeTask | null> {
  const r = getRedis();
  const result = await r.brpop(JUDGE_QUEUE, 0);
  if (result) {
    const task = JSON.parse(result[1]) as JudgeTask;
    console.log(`[MQ] Popped judge task: ${task.submission_id}`);
    return task;
  }
  return null;
}