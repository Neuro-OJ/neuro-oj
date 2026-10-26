import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { getDb, resetDbForTest } from "../../../src/shared/db/connection.ts";
import {
  recordSseEvent,
  replaySseEvents,
} from "../../../src/shared/sse/sse-events.ts";

Deno.test({
  name: "SSE 持久日志：与业务事务同时回滚，已提交事件可按序重放",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb(), channel = "test:transactional-notification";
    await assertRejects(
      () =>
        db.transaction(async (tx) => {
          await recordSseEvent(
            channel,
            { type: "notice", domain_id: "school" },
            tx,
          );
          throw new Error("业务写入失败");
        }),
      Error,
      "业务写入失败",
    );
    assertEquals(await replaySseEvents([channel], 0), []);
    const id = await db.transaction((tx) =>
      recordSseEvent(channel, { type: "notice", domain_id: "school" }, tx)
    );
    const replay = await replaySseEvents([channel], 0);
    assertEquals(replay.length, 1);
    assertEquals(replay[0].id, id);
    assertEquals(replay[0].payload, { type: "notice", domain_id: "school" });
  },
});
