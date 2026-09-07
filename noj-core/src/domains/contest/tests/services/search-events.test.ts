import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems } from "../../../../shared/db/schema.ts";
import { createContest } from "../../services/contests.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis } from "../../../../shared/mq/connection.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

Deno.test({
  name: "contest search event: 创建竞赛发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: "p-contest-event",
      title: "事件竞赛题目",
      description: "desc",
      difficulty: "easy",
      runtime_config: {},
      number: 1,
      owner_id: "0",
      type: "U",
      created_at: now,
      updated_at: now,
    });
    const startTime = new Date(Date.now() + 60_000).toISOString();
    const endTime = new Date(Date.now() + 3_600_000).toISOString();
    const contest = await createContest(
      {
        title: "事件竞赛",
        description: "desc",
        start_time: startTime,
        end_time: endTime,
        type: "kaggle",
        kind: "public",
        problems: [{
          problem_id: "p-contest-event",
          label: "A",
          sort_order: 0,
          score: 100,
        }],
      },
      "0",
      true,
    );
    await assertSearchEventPublished("contest", contest.id, "upsert");
  },
});
