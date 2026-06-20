import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createSubmission,
  getSubmission,
  saveEvaluationResult,
} from "../../src/services/submissions.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../src/lib/errors.ts";
import { eq } from "drizzle-orm";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const TEST_PROBLEM_ID = `tst-pr-${ts}`;
const TEST_USER_ID = `tst-user-${ts}`;

Deno.test({
  name: "submissions service: 初始化测试题目和用户",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: TEST_USER_ID,
      username: `tstuser-${ts}`,
      email: `tst-${ts}@test.noj`,
      password_hash: "hash",
      role: "user",
      created_at: now,
      updated_at: now,
    });
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
  },
});

Deno.test({
  name: "submissions service: 不支持的语言抛出 BadRequestError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSubmission(TEST_USER_ID, {
          problem_id: TEST_PROBLEM_ID,
          language: "brainfuck",
          code: "test code",
        }),
      BadRequestError,
      "不支持的语言",
    );
  },
});

Deno.test({
  name: "submissions service: 不存在的题目抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSubmission(TEST_USER_ID, {
          problem_id: "nonexistent-id",
          language: "python3",
          code: "print('hello')",
        }),
      NotFoundError,
      "题目不存在",
    );
  },
});

Deno.test({
  name: "submissions service: getSubmission 不存在的提交抛出 NotFoundError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await assertRejects(
      () => getSubmission("nonexistent-id", TEST_USER_ID),
      NotFoundError,
      "提交不存在",
    );
  },
});

Deno.test({
  name: "submissions service: saveEvaluationResult 保存评测结果",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const submissionId = `tst-sr-${ts}`;

    // 先插入一条 pending 状态的提交
    await db.insert(submissions).values({
      id: submissionId,
      user_id: TEST_USER_ID,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "print('test')",
      file_name: "main.py",
      status: "judging",
      created_at: now,
    });

    // 保存评测结果
    await saveEvaluationResult({
      submission_id: submissionId,
      status: "Accepted",
      score: 1000,
      output: "---RESULT---\n{}",
      details: { score_content: 10.0 },
      time_ms: 2340,
      memory_kb: 18432,
    });

    // 验证提交状态更新为 finished
    const sub = await db
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);
    assertEquals(sub[0].status, "finished");

    // 验证评测结果已插入
    const result = await db
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, submissionId))
      .limit(1);
    assertEquals(result.length, 1);
    assertEquals(result[0].status, "Accepted");
    assertEquals(result[0].score, 1000);
    assertEquals(result[0].time_ms, 2340);
    assertEquals(result[0].memory_kb, 18432);
  },
});

Deno.test({
  name: "submissions service: saveEvaluationResult 重复消费幂等",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const submissionId = `tst-idemp-${ts}`;

    // 插入提交
    await db.insert(submissions).values({
      id: submissionId,
      user_id: TEST_USER_ID,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "test",
      file_name: null,
      status: "judging",
      created_at: now,
    });

    // 第一次保存
    await saveEvaluationResult({
      submission_id: submissionId,
      status: "Accepted",
      score: 1000,
      output: "",
      details: {},
    });

    // 第二次保存（模拟重复消费）
    await saveEvaluationResult({
      submission_id: submissionId,
      status: "Accepted",
      score: 1000,
      output: "",
      details: {},
    });

    // 验证 evaluation_results 只有一条
    const rows = await db
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, submissionId));
    assertEquals(rows.length, 1, "重复消费不应插入多行");
  },
});
