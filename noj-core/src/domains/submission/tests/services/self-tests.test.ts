import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";

import {
  contests,
  problems,
  problemVersions,
  selfTests,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  pendingContestTimes,
  seedRunningContest,
} from "../../../../shared/testing/contest-fixtures.ts";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  createSelfTest,
  getSelfTest,
  saveSelfTestResult,
} from "../../index.ts";
import { SELF_TEST_ID_PREFIX } from "../../types/self-tests.ts";
import type { JudgeResult } from "../../index.ts";
import type { Context } from "hono";

const skip = false; // PGlite 内存数据库始终可用

const ts = Date.now();
const USER_ID = `tst-st-user-${ts}`;
const PROBLEM_ID = `tst-st-problem-${ts}`;
const OBJECTIVE_PROBLEM_ID = `tst-st-objective-${ts}`;
const SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;

const now = new Date().toISOString();

const runtimeConfig = {
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

// 模块级 setup：事务外初始化共享测试数据
await resetDbForTest();
const db = getDb();
await db.insert(users).values({
  id: USER_ID,
  username: `tstst-${ts}`,
  email: `tstst-${ts}@test.noj`,
  password_hash: "hash",
  created_at: now,
  updated_at: now,
});
await db.insert(problems).values([
  {
    id: PROBLEM_ID,
    title: "自测测试题",
    description: "测试描述",
    difficulty: "easy",
    runtime_config: runtimeConfig,
    number: 70000 + (ts % 10000),
    owner_id: USER_ID,
    type: "P",
    created_at: now,
    updated_at: now,
  },
  {
    id: OBJECTIVE_PROBLEM_ID,
    title: "客观题套卷",
    description: "客观题",
    difficulty: "easy",
    runtime_config: null,
    is_objective: true,
    number: 80000 + (ts % 10000),
    owner_id: USER_ID,
    type: "P",
    created_at: now,
    updated_at: now,
  },
]);

Deno.test({
  name: "self-tests service: 不支持的语言抛出 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSelfTest(USER_ID, PROBLEM_ID, {
          language: "ruby",
          code: "puts 1",
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "self-tests service: 客观题不支持自测",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSelfTest(USER_ID, OBJECTIVE_PROBLEM_ID, {
          language: "python3",
          code: "print(1)",
        }),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "self-tests service: 题目不存在抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSelfTest(USER_ID, "nonexistent-problem", {
          language: "python3",
          code: "print(1)",
        }),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "self-tests service: getSelfTest 不存在抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        getSelfTest(
          "st_nonexistent",
          { var: { userId: USER_ID } } as unknown as Context,
        ),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "self-tests service: saveSelfTestResult 对不存在记录返回 false",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result: JudgeResult = {
      submission_id: "st_unknown",
      status: "finished",
      score: 10000,
      output: "ok",
      details: {},
    };
    const applied = await saveSelfTestResult(result);
    assertEquals(applied, false);
  },
});

Deno.test({
  name: "self-tests service: saveSelfTestResult 写回且不影响正式表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.insert(selfTests).values({
      id: SELF_TEST_ID,
      user_id: USER_ID,
      problem_id: PROBLEM_ID,
      language: "python3",
      code: "print('hi')",
      status: "judging",
      created_at: now,
    });

    const result: JudgeResult = {
      submission_id: SELF_TEST_ID,
      status: "finished",
      score: 10000,
      output: "---RESULT---\n{}",
      details: { cases: [] },
      time_ms: 12,
      memory_kb: 1024,
    };
    const applied = await saveSelfTestResult(result);
    assertEquals(applied, true);

    const [row] = await db
      .select()
      .from(selfTests)
      .where(eq(selfTests.id, SELF_TEST_ID))
      .limit(1);
    assertEquals(row.status, "finished");
    assertEquals(row.result_status, "finished");
    assertEquals(row.score, 10000);

    const [sub] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, SELF_TEST_ID))
      .limit(1);
    assertEquals(sub, undefined);

    // 重复终态结果幂等忽略
    const appliedAgain = await saveSelfTestResult(result);
    assertEquals(appliedAgain, false);
  },
});

/**
 * 面 1.4 审计 F-03 回归：被**未结束公开赛**保密的题目，自测路径必须与详情/模板/
 * 支持包路径同口径返回 **404（NotFoundError）**，而不是 403。
 *
 * 若返回 403，则"403＝存在但保密"与"404＝不存在"的差异本身就是**存在性预言机**
 * ——display_id（P1001 形式）可枚举，攻击者据此即可在赛前确认某题已被某场尚未开始
 * 的公开赛收编。
 */
Deno.test({
  name: "self-tests service: 赛前筹备期保密题返回 404（存在性预言机回归 F-03）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const secretProblemId = `tst-st-secret-${ts}`;
    const secretNow = new Date().toISOString();
    await db.insert(problems).values({
      id: secretProblemId,
      title: "保密题（不得暴露存在性）",
      description: "题面",
      difficulty: "easy",
      runtime_config: runtimeConfig,
      number: 90000 + (ts % 10000),
      // owner 不是 USER_ID：确保以普通用户身份访问会被拒
      owner_id: "0",
      type: "P",
      visibility: "public",
      created_at: secretNow,
      updated_at: secretNow,
    });
    // 加入一场**尚未开始**（pending）的公开赛：最严重的泄密窗口
    const contestId = await seedRunningContest({
      problemIds: [secretProblemId],
      times: pendingContestTimes(),
    });

    // NotFoundError（而非 ForbiddenError）＝对外口径为"题目不存在"
    await assertRejects(
      () =>
        createSelfTest(USER_ID, secretProblemId, {
          language: "python3",
          code: "print(1)",
        }),
      NotFoundError,
    );

    await db.delete(contests).where(eq(contests.id, contestId));
    await db.delete(problems).where(eq(problems.id, secretProblemId));
  },
});

Deno.test({
  name: "self-tests service: 自测携带版本与执行快照（Handbook §4.2/§5.5）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const problemId = `tst-st-versioned-${ts}`;
    const versionId = `tst-st-versioned-v1-${ts}`;
    const versionConfig = {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 4321,
        memory_limit_mb: 321,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 4321,
        memory_limit_mb: 321,
      },
    };
    await db.insert(problems).values({
      id: problemId,
      title: "版本化自测题",
      description: "题面",
      difficulty: "easy",
      runtime_config: runtimeConfig,
      number: 91000 + (ts % 5000),
      owner_id: USER_ID,
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: {
        kind: "ai",
        title: "版本化自测题",
        description: "题面",
        samples: [],
        submission_mode: "code",
        runtime_config: versionConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      published_at: now,
    });
    await db.update(problems).set({ latest_version_id: versionId })
      .where(eq(problems.id, problemId));

    // 不属于该题的版本：逐字生效（404），不静默换版本
    let code: string | undefined;
    try {
      await createSelfTest(USER_ID, problemId, {
        language: "python3",
        code: "print(1)",
        version_id: `other-${ts}`,
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    assertEquals(code, "PROBLEM_VERSION_NOT_FOUND");

    // 正确版本：落库提交时版本 + 非敏感执行快照（评测队列不可用时也已完成写入）
    await createSelfTest(USER_ID, problemId, {
      language: "python3",
      code: "print(2)",
      version_id: versionId,
    }).catch(() => {/* 评测队列不可用属预期 */});

    const rows = await db.select().from(selfTests).where(
      and(
        eq(selfTests.user_id, USER_ID),
        eq(selfTests.problem_id, problemId),
      ),
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].problem_version_id, versionId);
    const snapshot = rows[0].task_snapshot as Record<string, unknown>;
    assertEquals(snapshot.problem_version_id, versionId);
    assertEquals(snapshot.language, "python3");
    assertEquals("eval_token" in snapshot, false);

    await db.delete(selfTests).where(eq(selfTests.problem_id, problemId));
    // 先摘掉最新版指针（复合外键 problems_latest_version_fk），再删版本
    await db.update(problems).set({ latest_version_id: null })
      .where(eq(problems.id, problemId));
    await db.delete(problemVersions).where(eq(problemVersions.id, versionId));
    await db.delete(problems).where(eq(problems.id, problemId));
  },
});

Deno.test({
  name: "self-tests service: 清理测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(selfTests).where(eq(selfTests.user_id, USER_ID));
    await db.delete(problems).where(eq(problems.id, PROBLEM_ID));
    await db.delete(problems).where(eq(problems.id, OBJECTIVE_PROBLEM_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
  },
});
