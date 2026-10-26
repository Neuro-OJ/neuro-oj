import { handleSearchIndexEvent } from "../../consumer/search-index-consumer.ts";

Deno.test({
  name: "search consumer: 未知实体类型跳过且不抛出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await handleSearchIndexEvent({
      entityType: "unknown_type",
      entityId: "entity-1",
      action: "upsert",
    });
  },
});

Deno.test({
  name: "search consumer: 缺少必要字段跳过且不抛出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await handleSearchIndexEvent(null);
    await handleSearchIndexEvent({ entityType: "", entityId: "entity-1" });
    await handleSearchIndexEvent({
      entityType: "problem",
      entityId: "entity-1",
      action: "bogus",
    });
  },
});
