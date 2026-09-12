import {
  type ConsumerHandle,
  createConsumer,
} from "../../../shared/mq/base-consumer.ts";
import { logger } from "../../../shared/base/logging.ts";
import {
  SEARCH_INDEX_QUEUE,
  type SearchIndexEvent,
} from "../../../shared/search-events.ts";
import { processSearchIndexEvent } from "../services/index-writer.ts";

const aliveRef = { value: false };

const KNOWN_ENTITY_TYPES = new Set([
  "problem",
  "user",
  "community_post",
  "community_comment",
  "contest",
  "submission",
  "message",
  "announcement",
]);

export async function handleSearchIndexEvent(data: unknown): Promise<void> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    logger.warn("搜索索引事件格式非法，已跳过", { data });
    return;
  }

  const event = data as unknown as SearchIndexEvent;
  if (
    typeof event.entityType !== "string" ||
    event.entityType.length === 0 ||
    typeof event.entityId !== "string" ||
    event.entityId.length === 0 ||
    (event.action !== "upsert" && event.action !== "delete")
  ) {
    logger.warn("搜索索引事件缺少必要字段或 action 非法，已跳过", {
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
    });
    return;
  }

  if (!KNOWN_ENTITY_TYPES.has(event.entityType)) {
    logger.warn("搜索索引事件实体类型未知，已跳过", {
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
    });
    return;
  }

  await processSearchIndexEvent(
    event.entityType,
    event.entityId,
    event.action,
  );
}

/** 当前消费者实例句柄（用于只停本消费者）。 */
let consumer: ConsumerHandle | null = null;

export function startSearchIndexConsumer(): ConsumerHandle {
  consumer = createConsumer({
    queueName: SEARCH_INDEX_QUEUE,
    logLabel: "搜索索引",
    aliveRef,
    handleMessage: handleSearchIndexEvent,
  });
  return consumer;
}

/**
 * 只停搜索索引消费者。
 *
 * 修复记录（2026-09-12 评审 §2.5）：此前这里调用 `requestConsumerShutdown()`，
 * 而该标记是三个消费者共享的单一布尔量 → 本想只停搜索索引，实际会把评测结果消费者
 * 与私信审核消费者一起停掉。现在走实例级 `requestShutdown()`。
 */
export function shutdownSearchIndexConsumer(): void {
  consumer?.requestShutdown();
}

export function isSearchIndexConsumerAlive(): boolean {
  return aliveRef.value;
}
