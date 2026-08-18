import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  problems,
  selfTests,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";
import {
  createSelfTest,
  getSelfTest,
  saveSelfTestResult,
} from "../../src/services/self-tests.ts";
import { SELF_TEST_ID_PREFIX } from "../../src/types/self-tests.ts";
import type { JudgeResult } from "../../src/types/index.ts";

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

Deno.test({
  name: "self-tests service: 初始化测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});

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
      () => getSelfTest("st_nonexistent", USER_ID, "user"),
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
      status: "Accepted",
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
      status: "Accepted",
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
    assertEquals(row.result_status, "Accepted");
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
