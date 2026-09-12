import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, problemTags } from "../../../../shared/db/schema.ts";
import { createTag, mergeTags } from "../../index.ts";
import { createProblem } from "../../services/problems/problems-crud.ts";
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
    // 不要 del(SEARCH_INDEX_QUEUE)：同一分片内多个测试文件会并行操作同一
    // Redis 键，删除会把对方正在等待观测的事件一并删掉（实测：全量分片必现假
    // 失败、单文件必过）。断言按本次生成的唯一 entityId 查找，无需清空。
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

Deno.test({
  name: "catalog search event: mergeTags 为受影响题目发布 upsert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const ts = Date.now();
    const source = await createTag({
      name: `事件合并源-${ts}`,
      kind: "algorithm",
    });
    const target = await createTag({
      name: `事件合并目标-${ts}`,
      kind: "algorithm",
    });
    const problemA = crypto.randomUUID();
    const problemB = crypto.randomUUID();
    await db.insert(problems).values([
      {
        id: problemA,
        title: "合并事件题A",
        description: "描述",
        difficulty: "easy",
        runtime_config: null,
        number: 940000 + (ts % 10000),
        owner_id: "0",
        type: "U",
        created_at: now,
        updated_at: now,
      },
      {
        id: problemB,
        title: "合并事件题B",
        description: "描述",
        difficulty: "easy",
        runtime_config: null,
        number: 950000 + (ts % 10000),
        owner_id: "0",
        type: "U",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(problemTags).values([
      { problem_id: problemA, tag_id: source.id },
      { problem_id: problemB, tag_id: source.id },
      { problem_id: problemB, tag_id: target.id },
    ]);
    await mergeTags(source.id, target.id);
    await assertSearchEventPublished("problem", problemA, "upsert");
    await assertSearchEventPublished("problem", problemB, "upsert");
  },
});
