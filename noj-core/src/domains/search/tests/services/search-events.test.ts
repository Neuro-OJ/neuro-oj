import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";
import { publishSearchIndexEvent } from "../../../../shared/search-events.ts";
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
    // 不要 del(SEARCH_INDEX_QUEUE)：同一分片内多个测试文件会并行操作同一
    // Redis 键，删除会把对方正在等待观测的事件一并删掉（实测：全量分片必现假
    // 失败、单文件必过）。断言按本次生成的唯一 entityId 查找，无需清空。
    await publishSearchIndexEvent("problem", "p-1", "upsert");
    await assertSearchEventPublished("problem", "p-1", "upsert");
  },
});
