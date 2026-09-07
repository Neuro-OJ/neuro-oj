import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { createProblem } from "../../services/problems/problems-crud.ts";
import { assertSearchEventPublished } from "../../../../../tests/helper/search-events.ts";
import { connectRedis, getRedis } from "../../../../shared/mq/connection.ts";
import { SEARCH_INDEX_QUEUE } from "../../../../shared/search-events.ts";

try {
  await connectRedis();
} catch (e) {
  if (!String(e).includes("already connecting/connected")) {
    console.warn("[setup] Redis 连接失败:", e);
  }
}

await resetDbForTest();

const VALID_RUNTIME_CONFIG = {
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
};

Deno.test({
  name: "catalog search event: 创建题目发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await getRedis().del(SEARCH_INDEX_QUEUE);
    const created = await createProblem({
      title: "事件测试题",
      description: "desc",
      difficulty: "easy",
      type: "U",
      runtime_config: VALID_RUNTIME_CONFIG,
    });
    await assertSearchEventPublished("problem", created.id, "upsert");
  },
});
