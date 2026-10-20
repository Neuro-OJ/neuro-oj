import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import {
  createProblem,
  deleteProblem,
  getProblem,
  getProblemDraft,
  listProblems,
  updateProblem,
} from "../../index.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  auditLogs,
  domainProblemBindings,
  problemBindingHistory,
  problems,
  selfTests,
  tags,
  users,
} from "../../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { enterTestContext } from "../../../../domains/system/index.ts";
import {
  bindPublishedProblemForTest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import type {
  OiRuntimeConfig,
  RuntimeConfig,
} from "../../types/runtime-config.ts";

// 独立测试数据库始终可用

const ts = Date.now();

// 共享 runtime_config 样例（其余 9 处用例复用；带网络版用于 network 校验用例）
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

const NETWORKED_RUNTIME_CONFIG = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    network: { enabled: true },
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

const OI_RUNTIME_CONFIG: OiRuntimeConfig = {
  backend: "native",
  languages: ["c", "cc"],
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  checker: { type: "default" },
  subtasks: [{
    id: "all",
    score: 100,
    cases: [{ input: "testdata/1.in", output: "testdata/1.out" }],
  }],
};

const now = new Date().toISOString();

// 模块级 setup：创建共享测试题目
await resetDbForTest();
const MODULE_PROBLEM = await createProblem({
  title: `测试题目 ${ts}`,
  description: "测试描述",
  difficulty: "easy",
  runtime_config: VALID_RUNTIME_CONFIG,
});
const TEST_PROBLEM_ID = MODULE_PROBLEM.id;

Deno.test({
  name: "problems service: 初始草稿写入失败时题目同事务回滚",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const title = "draft-write-rollback";
    // 在测试库制造草稿写入错误，证明不是只回滚提前校验失败的请求。
    await db.execute(
      sql`ALTER TABLE problem_drafts ADD CONSTRAINT test_initial_draft_failure CHECK (content->>'title' <> 'draft-write-rollback')`,
    );
    try {
      await assertRejects(() =>
        createProblem({
          title,
          description: "验证题目与草稿的原子写入",
          is_objective: true,
        })
      );
      assertEquals(
        await db.select({ id: problems.id }).from(problems).where(
          eq(problems.title, title),
        ),
        [],
      );
    } finally {
      await db.execute(
        sql`ALTER TABLE problem_drafts DROP CONSTRAINT test_initial_draft_failure`,
      );
    }
  },
});

Deno.test({
  name: "problems service: 列表返回正确分页结构",
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
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem({
      title: `临时创建题 ${ts}`,
      description: "用来测创建的",
      difficulty: "easy",
      runtime_config: VALID_RUNTIME_CONFIG,
    });
    assertEquals(problem.title, `临时创建题 ${ts}`);
    assertEquals(problem.difficulty, "easy");
    assertEquals(problem.tags, []);
    assertEquals(problem.has_hidden_algorithm_tags, false);
    // 新建 U 型默认 private（I1）
    assertEquals(problem.visibility, "public");
  },
});

Deno.test({
  name: "problems service: 新建 P 型默认 public",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem(
      {
        title: `临时 P 题 ${ts}`,
        description: "用来测 P 默认公开",
        difficulty: "easy",
        runtime_config: VALID_RUNTIME_CONFIG,
      },
      "0",
      "admin",
    );
    assertEquals(problem.visibility, "public");
  },
});

Deno.test({
  name: "problems service: 创建题目非法难度返回 BadRequestError",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createProblem({
          title: "非法难度题",
          description: "描述",
          difficulty: "expert",
          runtime_config: VALID_RUNTIME_CONFIG,
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems service: 创建题目时关联标签",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 先创建一个标签
    const db = getDb();
    const catId = `test-tag-${ts}`;
    await db.insert(tags).values({
      id: catId,
      name: `测试标签-${ts}`,
      kind: "problem",
      created_at: now,
      updated_at: now,
    });

    const problem = await createProblem({
      title: "带标签的题目",
      description: "描述",
      difficulty: "medium",
      runtime_config: VALID_RUNTIME_CONFIG,
      tag_ids: [catId],
    });
    assertEquals(problem.tags.length, 1);
    assertEquals(problem.tags[0].id, catId);
  },
});

Deno.test({
  name: "problems service: 获取题目详情含标签",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await getProblem(TEST_PROBLEM_ID);
    assertEquals(problem.id, TEST_PROBLEM_ID);
    assertEquals(problem.difficulty, "easy");
    assertEquals(Array.isArray(problem.tags), true);
  },
});

Deno.test({
  name: "problems service: 更新题目",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const updated = await updateProblem(TEST_PROBLEM_ID, {
      title: "更新的标题",
      difficulty: "hard",
    }, "0");
    // 新语义（Handbook §2.2/§6.2）：**内容**字段（title/description/样例/评测配置）
    // 写共享草稿，公开投影只由发布服务更新；管理信息（difficulty 等）立即生效。
    assertEquals(updated.difficulty, "hard");
    const draft = await getProblemDraft(TEST_PROBLEM_ID);
    assertEquals(draft.content.title, "更新的标题");
    // 内容入口不直写投影：题目行仍是创建时的标题，直到发布新版本才切换
    const persisted = await getProblem(TEST_PROBLEM_ID);
    assertEquals(persisted.title, `测试题目 ${ts}`);
  },
});

Deno.test({
  name: "problems service: 切换客观题会清理 OI 运行配置",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problem = await createProblem({
      title: `待切换 OI 题 ${ts}`,
      description: "切换客观题的边界",
      difficulty: "easy",
      runtime_config: OI_RUNTIME_CONFIG,
    });
    const updated = await updateProblem(problem.id, {
      is_objective: true,
    }, "0");
    assertEquals(updated.judge_type, "dual");
    assertEquals(updated.runtime_config, null);
  },
});

Deno.test({
  name: "problems service: 已发布题目的题型与提交模式不可变更（Handbook §2.3）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 未发布：仍允许切换题型（切换后投影同步，供编辑器继续编辑）
    const draftOnly = await createProblem({
      title: `未发布可切换 ${ts}`,
      description: "未发布题目允许改题型",
      difficulty: "easy",
      runtime_config: OI_RUNTIME_CONFIG,
    });
    const switched = await updateProblem(draftOnly.id, {
      is_objective: true,
    }, "0");
    assertEquals(switched.is_objective, true);

    // 已发布：切换题型必须 409 CONTENT_KIND_IMMUTABLE，且题目行不被改写
    const published = await createProblem({
      title: `已发布不可切换 ${ts}`,
      description: "已发布题目禁止跨题型转换",
      difficulty: "easy",
      runtime_config: OI_RUNTIME_CONFIG,
    });
    await publishBaselineVersionForTest(published.id);
    await assertRejects(
      () => updateProblem(published.id, { is_objective: true }, "0"),
      AppError,
      "首次发布后不可变更",
    );
    const [row] = await getDb().select({
      is_objective: problems.is_objective,
      judge_type: problems.judge_type,
    }).from(problems).where(eq(problems.id, published.id)).limit(1);
    assertEquals(row.is_objective, false);
    assertEquals(row.judge_type, "oi");

    // 已发布 AI 题的提交模式同样固定
    const ai = await createProblem({
      title: `已发布 AI 不可换模式 ${ts}`,
      description: "提交模式在首次发布后固定",
      difficulty: "easy",
      submission_mode: "code",
      runtime_config: VALID_RUNTIME_CONFIG,
    });
    await publishBaselineVersionForTest(ai.id);
    await assertRejects(
      () => updateProblem(ai.id, { submission_mode: "artifact" }, "0"),
      AppError,
      "提交模式在首次发布后不可变更",
    );
  },
});

Deno.test({
  name: "problems service: 更新非法难度返回 BadRequestError",
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
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 重建模块级题目，因为 resetDbForTest() 清掉了
    await createProblem({
      title: `测试题目 ${ts}`,
      description: "测试描述",
      difficulty: "easy",
      runtime_config: VALID_RUNTIME_CONFIG,
    });
    const result = await listProblems({ difficulty: "easy" });
    assertEquals(result.items.every((i) => i.difficulty === "easy"), true);
  },
});

// 按关键词搜索——自包含测试
Deno.test({
  name: "problems service: 按关键词搜索",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const keyword = `搜索测试-${ts}`;
    const created = await createProblem({
      title: `标题包含${keyword}`,
      description: `描述也包含${keyword}`,
      difficulty: "easy",
      runtime_config: VALID_RUNTIME_CONFIG,
    });
    // 搜索只覆盖 public 且**已发布**的题；新建 U 默认 private，先转 public 并发布基线版本
    await getDb().update(problems).set({
      visibility: "public",
      updated_at: new Date().toISOString(),
    }).where(eq(problems.id, created.id));
    await publishBaselineVersionForTest(created.id);
    const result = await listProblems({ keyword });
    assertEquals(result.items.length, 1);
    assertEquals(result.items[0].id, created.id);
  },
});

Deno.test({
  name: "problems service: 删除题目",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 自包含：创建后立即删除，不依赖模块级 TEST_PROBLEM_ID
    const toDelete = await createProblem({
      title: `待删除题目 ${ts}`,
      description: "将被删除",
      difficulty: "easy",
      runtime_config: VALID_RUNTIME_CONFIG,
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
  name: "problems service: 有自测记录的题目仍可删除（self_tests FK）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 触发条件：该题被任意用户自测过一次后 owner/admin 删除题目。
    // 修复前：self_tests.problem_id → problems.id 为 ON DELETE no action，
    // 且 deleteProblem 未清理 self_tests → PG 23503 → 全局 onError → 500，
    // 题目永久无法删除。
    const problem = await createProblem({
      title: `带自测的待删题目 ${ts}`,
      description: "带 self_tests 记录",
      difficulty: "easy",
      runtime_config: VALID_RUNTIME_CONFIG,
    });
    const now = new Date().toISOString();
    // 已终态的历史自测记录（`pending`/`judging` 属于活动评测，删除入口会拒绝并保留题目）
    const [binding] = await getDb().select().from(domainProblemBindings).where(
      eq(domainProblemBindings.problem_id, problem.id),
    );
    await getDb().insert(selfTests).values({
      domain_id: problem.domain_id,
      domain_problem_binding_id: binding.id,
      id: crypto.randomUUID(),
      user_id: "0",
      problem_id: problem.id,
      language: "python",
      code: "print(1)",
      status: "finished",
      created_at: now,
    });

    await deleteProblem(problem.id, "0");

    // 题目与其自测记录都应被清理
    await assertRejects(() => getProblem(problem.id), NotFoundError);
    const leftovers = await getDb()
      .select({ id: selfTests.id })
      .from(selfTests)
      .where(eq(selfTests.problem_id, problem.id));
    assertEquals(leftovers.length, 0);
  },
});

Deno.test({
  name: "problems service: deleteProblem 写一条 problems.delete 审计",
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
      created_at: now,
      updated_at: now,
    });

    await grantDefaultCatalogRole(adminId, "admin");
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
        runtime_config: VALID_RUNTIME_CONFIG,
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
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const result = await listProblems({ page: 2, limit: 1 });
    assertEquals(result.page, 2);
    assertEquals(result.limit, 1);
  },
});

Deno.test({
  name: "problems service: 系统调用（root 身份）开启 evaluator 联网放行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 创建 user-1 用户（owner_id FK）
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "user-1",
      username: `net-user-${Date.now()}`,
      email: `net-user-${Date.now()}@test.com`,
      password_hash: "not-used",
      created_at: now,
      updated_at: now,
    });
    // 无 c、无 userId/userRole = root 系统调用（守卫放行）；敏感字段权限的
    // 真实用户路径由 tests/routes/problem-field-guard.test.ts 覆盖
    const created = await createProblem(
      {
        title: `系统调用联网题 ${Date.now()}`,
        description: "系统调用可开启联网",
        difficulty: "easy",
        runtime_config: NETWORKED_RUNTIME_CONFIG,
      },
    );
    assertEquals(
      (created.runtime_config as RuntimeConfig).evaluator.network?.enabled,
      true,
    );
  },
});

Deno.test({
  name: "problems service: admin 开启 evaluator 联网放行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 创建 admin-1 用户（owner_id FK）
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "admin-1",
      username: `net-admin-${Date.now()}`,
      email: `net-admin-${Date.now()}@test.com`,
      password_hash: "not-used",
      created_at: now,
      updated_at: now,
    });
    await grantDefaultCatalogRole("admin-1", "admin");
    const created = await createProblem(
      {
        title: `admin 联网题 ${Date.now()}`,
        description: "admin 可开启联网",
        difficulty: "easy",
        runtime_config: NETWORKED_RUNTIME_CONFIG,
      },
      "admin-1",
      "admin",
    );
    assertEquals(
      (created.runtime_config as RuntimeConfig).evaluator.network?.enabled,
      true,
    );
  },
});

// Task 4：schema CHECK 三值。
//
// 迁移已经按 PostgreSQL 约束创建测试库，以下用例直接覆盖三值 CHECK。
Deno.test({
  name: "problems service: 创建 prediction 模式题目成功（CHECK 允许第三值）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // prediction 模式无 Solution 容器：runtime_config 省略 solution 也必须被接受。
    const created = await createProblem({
      title: `prediction 题 ${Date.now()}`,
      description: "预测提交题",
      difficulty: "medium",
      submission_mode: "prediction",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
      },
    });
    assertEquals(created.submission_mode, "prediction");
    assertEquals((created.runtime_config as RuntimeConfig).solution, undefined);
  },
});

Deno.test({
  name: "problems service: code 模式缺 solution 创建被拒（创建期强制）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createProblem({
          title: `缺 solution 的 code 题 ${Date.now()}`,
          description: "应被拒绝",
          difficulty: "easy",
          runtime_config: {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 5000,
              memory_limit_mb: 512,
            },
          },
        }),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );
  },
});

// 更新路径的模式切换完整性：prediction → code/artifact 时若省略 runtime_config，
// 必须按「生效 runtime_config」（即既有落库值）补校验 solution，避免留下缺
// solution 的 code/artifact 题（提交期才 500）。
Deno.test({
  name: "problems service: prediction 题改为 code 且省略 runtime_config 被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem({
      title: `prediction 转 code 缺配置 ${Date.now()}`,
      description: "切换模式但不提供 runtime_config",
      difficulty: "easy",
      submission_mode: "prediction",
      // prediction 合法形态：省略 solution
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
      },
    });
    assertEquals(created.submission_mode, "prediction");

    await assertRejects(
      () => updateProblem(created.id, { submission_mode: "code" }, "0"),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );

    // 校验失败后不得落库：模式仍为 prediction
    const [row] = await getDb()
      .select({ submission_mode: problems.submission_mode })
      .from(problems)
      .where(eq(problems.id, created.id))
      .limit(1);
    assertEquals(row.submission_mode, "prediction");
  },
});

Deno.test({
  name:
    "problems service: prediction 题改为 code 且提供缺 solution 的 runtime_config 被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem({
      title: `prediction 转 code 显式缺 solution ${Date.now()}`,
      description: "切换模式并显式给出不完整的 runtime_config",
      difficulty: "easy",
      submission_mode: "prediction",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
      },
    });

    await assertRejects(
      () =>
        updateProblem(
          created.id,
          {
            submission_mode: "code",
            runtime_config: {
              evaluator: {
                image: "noj-evaluator-python",
                command: "python3 /workspace/evaluate.py",
                time_limit_ms: 5000,
                memory_limit_mb: 512,
              },
            },
          },
          "0",
        ),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );
  },
});

// prediction → artifact 同样受约束（artifact 与 code 一致需要 Solution 容器）。
Deno.test({
  name:
    "problems service: prediction 题改为 artifact 且省略 runtime_config 被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem({
      title: `prediction 转 artifact 缺配置 ${Date.now()}`,
      description: "切换模式但不提供 runtime_config",
      difficulty: "easy",
      submission_mode: "prediction",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
      },
    });

    await assertRejects(
      () => updateProblem(created.id, { submission_mode: "artifact" }, "0"),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );
  },
});

Deno.test({
  name: "problems service: 非法 submission_mode 被拒（CHECK 允许值以外）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createProblem({
          title: `非法提交模式题 ${Date.now()}`,
          description: "应被拒绝",
          difficulty: "easy",
          submission_mode: "bogus",
          runtime_config: VALID_RUNTIME_CONFIG,
        }),
      BadRequestError,
    );
  },
});

// 直连 DB 写入非法值：绕过服务层枚举校验，验证 DB CHECK 本身。
Deno.test({
  name: "problems service: DB CHECK 拒绝非法 submission_mode（bogus）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await assertRejects(
      () =>
        db.insert(problems).values({
          id: crypto.randomUUID(),
          domain_id: DEFAULT_DOMAIN_ID,
          title: "bogus 模式直插",
          description: "应被 CHECK 拒绝",
          number: 999001,
          submission_mode: "bogus",
          created_at: now,
          updated_at: now,
        }),
    );
  },
});

// prediction 题禁止 LLM 配置：judge 的 prediction 路径不注入 NOJ_LLM_*，
// 题目级 llm_config 不会生效。创建/更新期 fail-fast，避免提交期才暴露。
Deno.test({
  name: "problems service: prediction 题携带 llm 创建被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await assertRejects(
      () =>
        createProblem(
          {
            title: `prediction 配 LLM ${Date.now()}`,
            description: "应被拒绝",
            difficulty: "easy",
            submission_mode: "prediction",
            runtime_config: {
              evaluator: {
                image: "noj-evaluator-python",
                command: "python3 /workspace/evaluate.py",
                time_limit_ms: 5000,
                memory_limit_mb: 512,
                network: { enabled: true },
              },
            },
            llm: { max_calls: 10 },
          },
          "0",
          "admin",
        ),
      BadRequestError,
      "预测提交题不支持 LLM 配置",
    );
  },
});

Deno.test({
  name: "problems service: 已配 LLM 的题目切为 prediction 被拒（需先移除 LLM）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const id = crypto.randomUUID();
    // 显式建立默认域题库中的联网题，验证草稿模式切换守卫。
    await db.insert(problems).values({
      id,
      domain_id: DEFAULT_DOMAIN_ID,
      title: `已有 LLM 的题 ${Date.now()}`,
      description: "更新为 prediction 应被拒绝",
      difficulty: "easy",
      number: 999500,
      owner_id: "0",
      runtime_config: NETWORKED_RUNTIME_CONFIG,
      llm_config: { max_calls: 10 },
      submission_mode: "code",
      created_at: now,
      updated_at: now,
    });
    await bindPublishedProblemForTest(id);

    await assertRejects(
      () =>
        updateProblem(
          id,
          {
            submission_mode: "prediction",
            runtime_config: {
              evaluator: {
                image: "noj-evaluator-python",
                command: "python3 /workspace/evaluate.py",
                time_limit_ms: 5000,
                memory_limit_mb: 512,
                network: { enabled: true },
              },
            },
          },
          "0",
          "admin",
        ),
      BadRequestError,
      "启用 LLM 的题目不能切换为预测提交",
    );

    // 同时显式移除 LLM 即可完成切换
    await updateProblem(
      id,
      {
        submission_mode: "prediction",
        llm: null,
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            network: { enabled: true },
          },
        },
      },
      "0",
      "admin",
    );
    // 内容写共享草稿（投影只由发布更新）：模式切换以草稿为准。
    const [row] = await db.select().from(problems).where(eq(problems.id, id));
    const draft = await getProblemDraft(id, row);
    assertEquals(
      (draft.content as { submission_mode?: string }).submission_mode,
      "prediction",
    );
  },
});

Deno.test({
  name: "problems service: prediction 题更新时添加 llm 被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const created = await createProblem(
      {
        title: `prediction 更新加 LLM ${Date.now()}`,
        description: "更新期应被拒绝",
        difficulty: "easy",
        submission_mode: "prediction",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            network: { enabled: true },
          },
        },
      },
      "0",
      "admin",
    );
    assertEquals(created.submission_mode, "prediction");

    await assertRejects(
      () =>
        updateProblem(
          created.id,
          { llm: { max_calls: 10 } },
          "0",
          "admin",
        ),
      BadRequestError,
      "预测提交题不支持 LLM 配置",
    );
  },
});

Deno.test({
  name: "problems service: 题型与后端筛选在分页前执行，客观题不计入 AI 后端",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const marker = `后端筛选-${crypto.randomUUID()}`;
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    const fixtures = [
      {
        judge_type: "dual",
        is_objective: false,
        runtime_config: VALID_RUNTIME_CONFIG,
      },
      {
        judge_type: "oi",
        is_objective: false,
        runtime_config: OI_RUNTIME_CONFIG,
      },
      {
        judge_type: "oi",
        is_objective: false,
        runtime_config: { ...OI_RUNTIME_CONFIG, backend: "wasm" },
      },
      { judge_type: "dual", is_objective: true, runtime_config: null },
    ];
    const db = getDb();
    try {
      await db.insert(problems).values(fixtures.map((fixture, index) => ({
        domain_id: DEFAULT_DOMAIN_ID,
        ...fixture,
        id: ids[index],
        title: `${marker}-${index}`,
        description: "筛选测试",
        difficulty: "easy",
        number: 9000000 + index,
        owner_id: "0",
        visibility: "public",
        created_at: now,
        updated_at: now,
      })));
      // 公共列表只含已发布题目：为每个夹具补基线版本
      for (const id of ids) await publishBaselineVersionForTest(id);
      const query = { keyword: marker, limit: 1 };
      const oi = await listProblems({ ...query, judge_type: "oi" });
      assertEquals(oi.total, 2);
      assertEquals(oi.items.length, 1);
      for (
        const [backend, index] of [["dual", 0], ["oi-native", 1], [
          "oi-wasm",
          2,
        ]] as const
      ) {
        const result = await listProblems({ ...query, judge_backend: backend });
        assertEquals(result.total, 1);
        assertEquals(result.items[0].id, ids[index]);
        assertEquals(result.items[0].judge_backend, backend);
        assertEquals(result.items[0].runtime_config, undefined);
      }
      assertEquals(
        (await listProblems({ ...query, judge_type: "dual" })).total,
        1,
      );
      assertEquals(
        (await listProblems({ ...query, judge_type: "objective" })).items[0].id,
        ids[3],
      );
      assertEquals(
        (await listProblems({
          ...query,
          judge_type: "dual",
          judge_backend: "oi-wasm",
        })).total,
        0,
      );
      await assertRejects(
        () => listProblems({ judge_type: "invalid" }),
        BadRequestError,
      );
      await assertRejects(
        () => listProblems({ judge_backend: "invalid" }),
        BadRequestError,
      );
    } finally {
      for (const id of ids) {
        await db.delete(problemBindingHistory).where(
          eq(problemBindingHistory.problem_id, id),
        );
        await db.delete(domainProblemBindings).where(
          eq(domainProblemBindings.problem_id, id),
        );
        await db.delete(problems).where(eq(problems.id, id));
      }
    }
  },
});

import { resetDbForTest } from "../default-fixture.ts";

import { grantDefaultCatalogRole } from "../default-fixture.ts";
