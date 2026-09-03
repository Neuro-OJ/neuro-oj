import type { JudgeTask } from "./../domains/submission/index.ts";
import { getRedis } from "./../shared/mq/connection.ts";
import { logJudgeTaskEnqueued } from "./../shared/base/logging.ts";

/**
 * 评测任务队列名称。
 * noj-judge 从该队列中 BRPOP 拉取任务。
 */
export const JUDGE_QUEUE = "noj:judge:queue";

/**
 * Redis 队列消息最大字节数。
 *
 * 留出充足冗余以避免在 Redis 集群环境下触达单值上限（默认 512MB），
 * 同时阻止用户提交的 base64 编码支持包 + 代码占用过多内存。
 */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // 16MB

/** 队列最大待评测数：超过后拒绝新提交，避免 Redis 内存无限增长。 */
export const MAX_JUDGE_QUEUE_LENGTH = 20_000;

/**
 * 原子执行“容量检查 + 入队”，避免 LLEN 与 LPUSH 之间的竞态窗口。
 * 返回 LPUSH 后的真实队列长度；容量已满时返回 -1。
 */
const QUEUE_CAPACITY_SCRIPT = `
local current = redis.call("LLEN", KEYS[1])
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

  // NOJ-077：用单条 Lua 脚本原子完成容量检查和入队，拒绝而不是静默丢最老任务。
  const length = await redis.eval(
    QUEUE_CAPACITY_SCRIPT,
    1,
    JUDGE_QUEUE,
    MAX_JUDGE_QUEUE_LENGTH,
    message,
  );
  if (length < 0) {
    throw new Error(
      `评测队列已满（${MAX_JUDGE_QUEUE_LENGTH}/${MAX_JUDGE_QUEUE_LENGTH}），请稍后重试`,
    );
  }

  // 注意：不要对主队列设置 EXPIRE。Redis 列表在变为空时会自动删除 key；
  // 对非空列表设置 TTL 会在队列积压且没有新提交时把整个队列（含未消费任务）一起删掉。
  logJudgeTaskEnqueued(task.submission_id, length, messageBytes);
  return length;
}
