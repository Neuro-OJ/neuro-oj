import { eq } from "drizzle-orm";
import { createConsumer } from "./base-consumer.ts";
import { getDb } from "../db/connection.ts";
import { messages } from "../db/schema.ts";
import { logger } from "./../shared/base/logging.ts";
import {
  type DmReviewTask,
  getReviewConfig,
  REVIEW_DM_QUEUE,
  runContentReview,
} from "../domains/content-review/index.ts";

/**
 * 私信异步审核消费者（issue #413）。
 *
 * 消费 noj:review:dm 队列中的 DmReviewTask：
 * 1. 校验消息仍存在且为文本
 * 2. 调云审核（复用 runContentReview：超时/异常 fail-open 转人工）
 * 3. 结果写入统一审查队列 content_review_queue
 *
 * 命中/疑似不即时影响发送方/接收方（不改消息、不撤回）。
 */

/** 消费者活跃状态标识（供健康检查/测试）。 */
export const reviewConsumerAlive = { value: false };

/** 测试注入点：替换 handleMessage（仿结果消费者工厂注入模式）。 */
export type ReviewConsumerHandler = (
  data: Record<string, unknown>,
) => Promise<void>;

let handlerForTest: ReviewConsumerHandler | null = null;

/** 测试用：注入自定义 handler（传 null 恢复默认）。 */
export function _setReviewConsumerHandlerForTest(
  handler: ReviewConsumerHandler | null,
): void {
  handlerForTest = handler;
}

/**
 * 处理一条私信审核任务。
 * 写库/审核失败向上抛错 → base-consumer 自动重投（at-least-once）。
 */
export async function handleDmReviewMessage(
  data: Record<string, unknown>,
): Promise<void> {
  const task = data as unknown as DmReviewTask;
  if (!task.message_id || !task.content) {
    logger.error("私信审核任务缺少 message_id/content，跳过", {
      message_id: task.message_id,
    });
    return;
  }

  const config = getReviewConfig();
  if (!config.enabled || !config.asyncEnabled) {
    logger.info("内容审核已关闭，私信审核任务跳过");
    return;
  }

  // 消息仍存在且为文本（图片消息在入队端已过滤，这里兜底）
  const db = getDb();
  const [msg] = await db.select({
    id: messages.id,
    conversation_id: messages.conversation_id,
    sender_id: messages.sender_id,
    type: messages.type,
    content: messages.content,
    recalled_at: messages.recalled_at,
  }).from(messages).where(eq(messages.id, task.message_id)).limit(1);

  if (!msg || msg.type !== "text") {
    logger.info("私信审核任务目标消息不存在或非文本，跳过", {
      message_id: task.message_id,
    });
    return;
  }

  const outcome = await runContentReview({
    content_type: "message",
    target_id: msg.id,
    channel: "dm",
    text: msg.content,
    enabled: true,
    meta: {
      conversation_id: msg.conversation_id,
      sender_id: msg.sender_id,
    },
  });

  logger.info("私信审核完成", {
    message_id: msg.id,
    action: outcome.action,
  });
}

/**
 * 创建私信审核消费者（自动重连 + 失败重投语义与评测结果消费者一致）。
 * @returns 启动函数（不返回，直到进程关闭）。
 */
export function createReviewConsumer(): () => Promise<void> {
  return createConsumer({
    queueName: REVIEW_DM_QUEUE,
    logLabel: "私信审核",
    aliveRef: reviewConsumerAlive,
    handleMessage: async (data) => {
      if (handlerForTest) {
        await handlerForTest(data);
      } else {
        await handleDmReviewMessage(data);
      }
    },
    requeueOnError: true,
  });
}
