import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createProblem,
  deleteProblem,
  getProblem,
  listProblems,
  updateProblem,
} from "../../src/services/problems.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  categories,
  problems,
  problemsCategories,
} from "../../src/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const TEST_PROBLEM_ID = `test-${ts}`;

const now = new Date().toISOString();

Deno.test({
  name: "problems service: 列表返回正确分页结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await listProblems({ page: 1, limit: 10 });
    assertEquals(Array.isArray(result.items), true);
    assertEquals(typeof result.total, "number");
    assertEquals(result.page, 1);
    assertEquals(result.limit, 10);
  },
});

Deno.test({
  name: "problems service: 创建题目成功",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const problem = await createProblem({
      id: TEST_PROBLEM_ID,
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    });
    assertEquals(problem.id, TEST_PROBLEM_ID);
    assertEquals(problem.title, `测试题目 ${ts}`);
    assertEquals(problem.difficulty, "easy");
    assertEquals(problem.categories, []);
  },
});

Deno.test({
  name: "problems service: 创建题目非法难度返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createProblem({
          title: "非法难度题",
          description: "描述",
          difficulty: "expert",
          judge_image: "noj-judge-python",
          judge_command: "python3 /tmp/evaluate.py",
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems service: 创建题目时关联分类",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 先创建一个分类
    const db = getDb();
    const catId = `test-cat-${ts}`;
    await db.insert(categories).values({
      id: catId,
      name: "测试分类",
      slug: `test-cat-${ts}`,
      description: "",
      parent_id: null,
      level: 0,
      created_at: now,
      updated_at: now,
    });

    const problem = await createProblem({
      id: `test-with-cat-${ts}`,
      title: "带分类的题目",
      description: "描述",
      difficulty: "medium",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      category_ids: [catId],
    });
    assertEquals(problem.categories.length, 1);
    assertEquals(problem.categories[0].id, catId);
  },
});

Deno.test({
  name: "problems service: 获取题目详情含分类",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const problem = await getProblem(TEST_PROBLEM_ID);
    assertEquals(problem.id, TEST_PROBLEM_ID);
    assertEquals(problem.difficulty, "easy");
    assertEquals(Array.isArray(problem.categories), true);
  },
});

Deno.test({
  name: "problems service: 更新题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const updated = await updateProblem(TEST_PROBLEM_ID, {
      title: "更新的标题",
      difficulty: "hard",
    }, "0");
    assertEquals(updated.title, "更新的标题");
    assertEquals(updated.difficulty, "hard");
  },
});

Deno.test({
  name: "problems service: 更新非法难度返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => updateProblem(TEST_PROBLEM_ID, { difficulty: "invalid" }, "0"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems service: 按难度筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await listProblems({ difficulty: "easy" });
    assertEquals(result.items.every((i) => i.difficulty === "easy"), true);
  },
});

Deno.test({
  name: "problems service: 按关键词搜索",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 创建含关键词的题目
    const keyword = `搜索测试-${ts}`;
    await createProblem({
      id: `search-test-${ts}`,
      title: `标题包含${keyword}`,
      description: `描述也包含${keyword}`,
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
    });
    const result = await listProblems({ keyword, type: "U" });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0].id, `search-test-${ts}`);
  },
});

Deno.test({
  name: "problems service: 删除题目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await deleteProblem(TEST_PROBLEM_ID, "0");
    await assertRejects(
      () => getProblem(TEST_PROBLEM_ID),
      NotFoundError,
      "题目不存在",
    );
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
    const result = await listProblems({ page: 2, limit: 1 });
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
      await db.delete(problemsCategories);
      await db.delete(categories);
      await db.delete(problems);
    } catch {
      // ignore
    }
  },
});
