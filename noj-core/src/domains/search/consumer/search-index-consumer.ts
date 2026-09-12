import {
  createConsumer,
  requestConsumerShutdown,
} from "../../../shared/mq/base-consumer.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "search"]);
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

export function startSearchIndexConsumer(): () => Promise<void> {
  return createConsumer({
    queueName: SEARCH_INDEX_QUEUE,
    logLabel: "搜索索引",
    aliveRef,
    handleMessage: handleSearchIndexEvent,
  });
}

export function shutdownSearchIndexConsumer(): void {
  requestConsumerShutdown();
}

export function isSearchIndexConsumerAlive(): boolean {
  return aliveRef.value;
}
