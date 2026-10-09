import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, users } from "../../../../shared/db/schema.ts";
import { createSubmission } from "../../services/submissions/submissions-crud.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import {
  connectRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";

await resetDbForTest();

Deno.test({
  name: "submission search event: 创建提交发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 每个用例绑定自己的 Redis，避免其他队列用例遗留的 mock 连接影响事件断言。
    const originalRedisUrl = Deno.env.get("REDIS_URL");
    const fake = startFakeRedis();
    Deno.env.set("REDIS_URL", fake.url);
    resetRedisForTest();
    try {
      await connectRedis();
      await resetDbForTest();
      const db = getDb();
      const now = new Date().toISOString();
      await db.insert(users).values({
        id: "u-sub-event",
        username: "sub_event",
        email: "sub-event@example.com",
        password_hash: "x",
        created_at: now,
        updated_at: now,
      });
      await db.insert(problems).values({
        id: "p-sub-event",
        title: "提交事件题",
        description: "",
        difficulty: "easy",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
        number: 1,
        type: "P",
        visibility: "public",
        created_at: now,
        updated_at: now,
      });
      // 不要 del(SEARCH_INDEX_QUEUE)：同一分片内多个测试文件会并行操作同一
      // Redis 键，删除会把对方正在等待观测的事件一并删掉（实测：全量分片必现假
      // 失败、单文件必过）。断言按本次生成的唯一 entityId 查找，无需清空。
      const submission = await createSubmission("u-sub-event", {
        problem_id: "p-sub-event",
        language: "python",
        code: "print(1)",
      });
      await assertSearchEventPublished("submission", submission.id, "upsert");
    } finally {
      resetRedisForTest();
      if (originalRedisUrl) Deno.env.set("REDIS_URL", originalRedisUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});
