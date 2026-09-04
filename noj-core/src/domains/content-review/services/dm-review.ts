import { getRedis } from "./../../../shared/mq/connection.ts";
import { getReviewConfig } from "./review-common.ts";
import { logger } from "./../../../shared/base/logging.ts";

/**
 * 私信异步审核队列（issue #413）。
 *
 * 发送成功后调用 enqueueDmMessageReview，把消息文本 LPUSH 到 Redis 队列；
 * 消费者（mq/review-consumer.ts）BRPOP 拉取后调云审核并写统一审查队列。
 * 送审只传文本内容（不传图片地址/会话双方 ID 之外的上下文）。
 *
 * fail-open：Redis 不可用/入队失败仅记 warning，不阻断发送。
 */

/** 私信审核队列名（与 mq/review-consumer.ts 共用）。 */
export const REVIEW_DM_QUEUE = "noj:review:dm";

/** 入队消息体（仅文本 + 定位信息，不含图片）。 */
export interface DmReviewTask {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  /** 送审文本（私信只传文本） */
  content: string;
  created_at: string;
}

/**
 * 私信消息发送成功后异步送审入队。
 * 开关：content_review_enabled + content_review_async_enabled。
 * @returns 是否成功入队（false = 开关关闭/非文本消息，不视为错误）
 */
export async function enqueueDmMessageReview(
  message: DmReviewTask,
): Promise<boolean> {
  const config = getReviewConfig();
  // 总开关或异步队列开关关闭 → 不送审
  if (!config.enabled || !config.asyncEnabled) return false;

  try {
    const redis = getRedis();
    if (redis.status !== "ready") {
      logger.warn(
        "[content-review] Redis 不可用，私信异步审核跳过（fail-open）",
      );
      return false;
    }
    await redis.rpush(REVIEW_DM_QUEUE, JSON.stringify(message));
    return true;
  } catch (err) {
    logger.warn("[content-review] 私信审核入队失败（fail-open，不阻断发送）", {
      err,
    });
    return false;
  }
}
