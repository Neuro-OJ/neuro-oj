import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import {
  publishSearchIndexEvent,
  SEARCH_INDEX_QUEUE,
} from "../../../../shared/search-events.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "search event: publishSearchIndexEvent 发布问题 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await getRedis().del(SEARCH_INDEX_QUEUE);
    await publishSearchIndexEvent("problem", "p-1", "upsert");
    await assertSearchEventPublished("problem", "p-1", "upsert");
  },
});
