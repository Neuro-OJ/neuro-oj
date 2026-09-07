import {
  createConsumer,
  requestConsumerShutdown,
} from "../../../shared/mq/base-consumer.ts";
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
      const event = data as unknown as SearchIndexEvent;
      if (!event.entityType || !event.entityId || !event.action) {
        throw new Error("搜索索引事件缺少必要字段");
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
