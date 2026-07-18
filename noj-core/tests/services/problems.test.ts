import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  createProblem,
  deleteProblem,
  getProblem,
  listProblems,
  updateProblem,
} from "../../src/services/problems.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { auditLogs, categories, users } from "../../src/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";
import { enterTestContext } from "../../src/lib/requestContext.ts";

// PGlite 内存数据库始终可用
const dbAvailable = true;
const skip = !dbAvailable;

const ts = Date.now();

const now = new Date().toISOString();

// 模块级 setup：创建共享测试题目
await resetDbForTest();
const MODULE_PROBLEM = await createProblem({
  title: `测试题目 ${ts}`,
  description: "测试描述",
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
      entry: "submission_sample.py",
      call_timeout_ms: 2000,
      memory_limit_mb: 512,
    },
  },
});
const TEST_PROBLEM_ID = MODULE_PROBLEM.id;

Deno.test({
  name: "problems service: 列表返回正确分页结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
    const problem = await createProblem({
      title: `临时创建题 ${ts}`,
      description: "用来测创建的",
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
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
    });
    assertEquals(problem.title, `临时创建题 ${ts}`);
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
    await assertRejects(
      () =>
        createProblem({
          title: "非法难度题",
          description: "描述",
          difficulty: "expert",
          runtime_config: {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 5000,
              memory_limit_mb: 512,
            },

            solution: {
              image: "noj-solution-python",
              entry: "submission_sample.py",
              call_timeout_ms: 2000,
              memory_limit_mb: 512,
            },
          },
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
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },

        solution: {
          image: "noj-solution-python",
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
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
    // 重建模块级题目，因为 resetDbForTest() 清掉了
    await createProblem({
      title: `测试题目 ${ts}`,
      description: "测试描述",
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
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
    });
    const result = await listProblems({ difficulty: "easy", type: "U" });
    assertEquals(result.items.every((i) => i.difficulty === "easy"), true);
  },
});

// 按关键词搜索——自包含测试
Deno.test({
  name: "problems service: 按关键词搜索",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const keyword = `搜索测试-${ts}`;
    const created = await createProblem({
      title: `标题包含${keyword}`,
      description: `描述也包含${keyword}`,
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
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
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
    // 自包含：创建后立即删除，不依赖模块级 TEST_PROBLEM_ID
    const toDelete = await createProblem({
      title: `待删除题目 ${ts}`,
      description: "将被删除",
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
          entry: "submission_sample.py",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
    });
    await deleteProblem(toDelete.id, "0");
    await assertRejects(
      () => getProblem(toDelete.id),
      NotFoundError,
      "题目不存在",
    );
  },
});

Deno.test({
  name: "problems service: deleteProblem 写一条 problems.delete 审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();

    // 准备：admin 操作者（满足 audit_logs.admin_id FK）
    const db = getDb();
    const adminId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: adminId,
      username: `test-del-prob-admin-${Date.now()}`,
      email: `test-del-prob-admin-${Date.now()}@example.com`,
      password_hash: "",
      role: "admin",
      created_at: now,
      updated_at: now,
    });

    // 注入 admin actor context（logAudit 依赖 RequestContext）
    enterTestContext({
      actorId: adminId,
      actorIp: "10.0.0.42",
      actorRole: "admin",
    });

    // 创建题目（admin 创建，owner=admin，避免权限检查失败）
    const toDelete = await createProblem(
      {
        title: `待删除审计题 ${Date.now()}`,
        description: "将触发 problems.delete 审计",
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
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
      adminId,
      "admin",
    );

    // 清空本测试前可能存在的审计行，避免行数偏差
    await getDb().delete(auditLogs);

    // 执行：删除题目（admin 可删任意题）
    await deleteProblem(toDelete.id, adminId, "admin");

    // 验证：审计日志写入
    const rows = await getDb().select().from(auditLogs).where(
      eq(auditLogs.action, "problems.delete"),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].target_type, "problem");
    assertEquals(rows[0].target_id, toDelete.id);
    assertEquals(rows[0].admin_id, adminId);
    assertEquals(rows[0].ip_address, "10.0.0.42");
    const detail = rows[0].detail as {
      action: string;
      title: string;
      display_id: string;
    };
    assertEquals(detail.action, "problems.delete");
    assertEquals(detail.title, toDelete.title);
    assertEquals(detail.display_id, toDelete.display_id);
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
