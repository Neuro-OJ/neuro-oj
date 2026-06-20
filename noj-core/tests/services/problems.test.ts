import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { listProblems, getProblem } from "../../src/services/problems.ts";
import { resetDbForTest, getDb } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";
import { NotFoundError } from "../../src/lib/errors.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const TEST_PROBLEM_ID = `test-${ts}`;

Deno.test({
  name: "problems service: 列表返回正确分页结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await listProblems(1, 10);
    assertEquals(Array.isArray(result.items), true);
    assertEquals(typeof result.total, "number");
    assertEquals(result.page, 1);
    assertEquals(result.limit, 10);
  },
});

Deno.test({
  name: "problems service: 插入后查询返回正确 total",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();

    await db.insert(problems).values({
      id: TEST_PROBLEM_ID,
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
      created_at: now,
      updated_at: now,
    });

    const result = await listProblems(1, 10);
    assertEquals(result.total >= 1, true);
    assertEquals(result.items.some((i) => i.id === TEST_PROBLEM_ID), true);
    const ourProblem = result.items.find((i) => i.id === TEST_PROBLEM_ID)!;
    assertEquals(ourProblem.judge_image, "noj-judge-python");
    assertEquals(ourProblem.judge_command, "python3 /tmp/evaluate.py");
  },
});

Deno.test({
  name: "problems service: getProblem 返回题目详情",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const problem = await getProblem(TEST_PROBLEM_ID);
    assertEquals(problem.id, TEST_PROBLEM_ID);
    assertEquals(problem.title, `测试题目 ${ts}`);
    assertEquals(problem.difficulty, "easy");
    assertEquals(typeof problem.judge_image, "string");
    assertEquals(typeof problem.judge_command, "string");
  },
});

Deno.test({
  name: "problems service: 不存在的题目抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => getProblem("nonexistent-id"),
      NotFoundError,
      "题目不存在",
    );
  },
});

Deno.test({
  name: "problems service: 分页 limit 和 page 生效",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await listProblems(2, 1);
    assertEquals(result.page, 2);
    assertEquals(result.limit, 1);
  },
});

// 清理
Deno.test({
  name: "problems service: cleanup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const db = getDb();
      await db.delete(problems);
    } catch {
      // ignore
    }
  },
});
