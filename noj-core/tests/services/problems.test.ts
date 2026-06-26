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
let TEST_PROBLEM_ID: string;

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
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    });
    // id 由服务端生成 UUID，记录供后续测试引用
    TEST_PROBLEM_ID = problem.id;
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
    const created = await createProblem({
      title: `标题包含${keyword}`,
      description: `描述也包含${keyword}`,
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
    });
    const result = await listProblems({ keyword, type: "U" });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0].id, created.id);
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

// ── issue #66: judge_type round-trip + 校验 ──

Deno.test({
  name: "problems service: 不传 judge_type 默认 special",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const problem = await createProblem({
      title: `默认 special ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
    });
    assertEquals(problem.judge_type, "special");
  },
});

Deno.test({
  name: "problems service: 创建题目时显式指定 judge_type=standard",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const problem = await createProblem({
      title: `标准题 ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      judge_type: "standard",
    });
    assertEquals(problem.judge_type, "standard");
  },
});

Deno.test({
  name: "problems service: 非法 judge_type 返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createProblem({
          title: "非法 judge_type",
          description: "测试",
          difficulty: "easy",
          judge_image: "noj-judge-python",
          judge_command: "python3 /tmp/evaluate.py",
          judge_type: "bogus",
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems service: 更新题目 judge_type 从 special → standard",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem({
      title: `待更新 judge_type ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
    });
    assertEquals(created.judge_type, "special");

    const updated = await updateProblem(created.id, {
      judge_type: "standard",
    }, "0");
    assertEquals(updated.judge_type, "standard");
  },
});

Deno.test({
  name: "problems service: 更新非法 judge_type 返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem({
      title: `更新非法 judge_type ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
    });
    await assertRejects(
      () => updateProblem(created.id, { judge_type: "invalid" }, "0"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems service: 按 judge_type=standard 过滤",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await createProblem({
      title: `过滤 standard ${ts}`,
      description: "测试",
      difficulty: "easy",
      judge_image: "noj-judge-python",
      judge_command: "python3 /tmp/evaluate.py",
      judge_type: "standard",
    });
    const result = await listProblems({ judge_type: "standard" });
    assertEquals(result.items.every((i) => i.judge_type === "standard"), true);
  },
});

Deno.test({
  name: "problems service: 按 judge_type=invalid 过滤返回 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () => listProblems({ judge_type: "invalid" }),
      BadRequestError,
    );
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
