import {
  createConsumer,
  requestConsumerShutdown,
} from "../../../shared/mq/base-consumer.ts";
import { logger } from "../../../shared/base/logging.ts";
import {
  SEARCH_INDEX_QUEUE,
  type SearchIndexEvent,
} from "../../../shared/search-events.ts";
import { processSearchIndexEvent } from "../services/index-writer.ts";

const aliveRef = { value: false };

export function startSearchIndexConsumer(): () => Promise<void> {
  return createConsumer({
    queueName: SEARCH_INDEX_QUEUE,
    logLabel: "搜索索引",
    aliveRef,
    handleMessage: async (data) => {
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

      await processSearchIndexEvent(
        event.entityType,
        event.entityId,
        event.action,
      );
    },
  });
}

export function shutdownSearchIndexConsumer(): void {
  requestConsumerShutdown();
}

export function isSearchIndexConsumerAlive(): boolean {
  return aliveRef.value;
}
