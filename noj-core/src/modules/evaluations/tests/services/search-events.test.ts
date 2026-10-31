import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { publishBaselineVersionForTest } from "../../../../../tests/helper.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { ensureDefaultWorkspace } from "../../../access/workspace/index.ts";
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
      await ensureDefaultWorkspace();
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
        domain_id: DEFAULT_DOMAIN_ID,
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
        visibility: "public",
        created_at: now,
        updated_at: now,
      });
      const submission = await createSubmission("u-sub-event", {
        problem_id: "p-sub-event",
        version_id: await publishBaselineVersionForTest("p-sub-event"),
        language: "python",
        code: "print(1)",
      });
      await assertSearchEventPublished("submission", submission.id, "upsert");
    } finally {
      resetRedisForTest();
      if (originalRedisUrl === undefined) Deno.env.delete("REDIS_URL");
      else Deno.env.set("REDIS_URL", originalRedisUrl);
      await fake.stop();
    }
  },
});
