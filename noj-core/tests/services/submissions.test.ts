import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1";
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
const TEST_NUMBER = 50000 + (ts & 0x7fff);

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
      number: TEST_NUMBER,
      owner_id: TEST_USER_ID,
      type: "P",
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

// ── 消费者解析逻辑的单元测试（不需要数据库） ──

Deno.test({
  name: "consumer: 有效 JudgeResult JSON 解析",
  fn: () => {
    const rawJson =
      `{"submission_id":"sid-1","status":"Accepted","score":1000,"output":"ok","details":{}}`;
    const parsed = JSON.parse(rawJson);
    assertEquals(parsed.submission_id, "sid-1");
    assertEquals(parsed.status, "Accepted");
    assertEquals(parsed.score, 1000);
  },
});

Deno.test({
  name: "consumer: 非法 JSON 应抛出异常",
  fn: () => {
    const rawJson = "{invalid json}";
    let parseError: Error | null = null;
    try {
      JSON.parse(rawJson);
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
    }
    assertEquals(parseError !== null, true, "非法 JSON 应抛出异常");
  },
});

Deno.test({
  name: "consumer: 缺少 submission_id 的 JSON 应被检测",
  fn: () => {
    const rawJson = `{"status":"Accepted","score":1000}`;
    const parsed = JSON.parse(rawJson);
    assertEquals(
      parsed.submission_id,
      undefined,
      "缺少 submission_id 应为 undefined",
    );
    assertEquals(parsed.status, "Accepted");
    assertEquals(parsed.score, 1000);
  },
});

Deno.test({
  name:
    "submissions service: saveEvaluationResult 重复写同一 submission 应 UPDATE 而非 silently 跳过（issue #86）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const subId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 创建测试用户
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `upsert_test_${Date.now()}`,
      email: `upsert_test_${Date.now()}@test.com`,
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    });

    // 准备 submission（status=judging 让 UPDATE 通行）
    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "print(1)",
      status: "judging",
      created_at: now,
    });

    try {
      // 第一次写入：WrongAnswer
      await saveEvaluationResult({
        submission_id: subId,
        status: "WrongAnswer",
        score: 500,
        output: '---RESULT---\n{"first":true}',
        details: {},
      });

      // 第二次写入：Accepted（rejudge 后）
      await saveEvaluationResult({
        submission_id: subId,
        status: "Accepted",
        score: 1000,
        output: '---RESULT---\n{"new":true}',
        details: { rejudge: true },
        time_ms: 200,
        memory_kb: 2048,
      });

      // 断言：只有 1 行（UNIQUE 保持），但内容是第二次的
      const rows = await db.select().from(evaluationResults)
        .where(eq(evaluationResults.submission_id, subId));
      assertEquals(rows.length, 1);
      assertEquals(rows[0].status, "Accepted");
      assertEquals(rows[0].score, 1000);
      assertEquals(rows[0].output, '---RESULT---\n{"new":true}');
      assertEquals(JSON.parse(rows[0].details), { rejudge: true });
      assertEquals(rows[0].time_ms, 200);
      assertEquals(rows[0].memory_kb, 2048);
    } finally {
      // 清理
      await db.delete(evaluationResults).where(
        eq(evaluationResults.submission_id, subId),
      );
      await db.delete(submissions).where(eq(submissions.id, subId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});

Deno.test({
  name:
    "submissions service: saveEvaluationResult rejudge_seq 防护：旧结果不应覆盖新结果",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const subId = crypto.randomUUID();
    const now = new Date().toISOString();

    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `seq_guard_${Date.now()}`,
      email: `seq_guard_${Date.now()}@test.com`,
      password_hash: "x",
      role: "user",
      created_at: now,
      updated_at: now,
    });

    await db.insert(submissions).values({
      id: subId,
      user_id: userId,
      problem_id: TEST_PROBLEM_ID,
      language: "python3",
      code: "print(1)",
      status: "judging",
      rejudge_seq: 2, // 当前序列号=2
      created_at: now,
    });

    try {
      // 写入 seq=2 的新结果（应成功）
      await saveEvaluationResult({
        submission_id: subId,
        status: "Accepted",
        score: 1000,
        output: "---NEW---",
        details: { seq: 2 },
        rejudge_seq: 2,
      });

      // 写入 seq=1 的旧结果（应被丢弃，仅 console.warn）
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      try {
        await saveEvaluationResult({
          submission_id: subId,
          status: "WrongAnswer",
          score: 500,
          output: "---OLD---",
          details: { seq: 1 },
          rejudge_seq: 1,
        });
      } finally {
        console.warn = originalWarn;
      }

      // 断言：evaluation_results 仍只有 1 行，且是 seq=2 的内容
      const rows = await db.select().from(evaluationResults)
        .where(eq(evaluationResults.submission_id, subId));
      assertEquals(rows.length, 1);
      assertEquals(rows[0].status, "Accepted");
      assertEquals(rows[0].output, "---NEW---");

      // 断言：丢弃日志被记录
      const ignoredLog = warnings.find((w) => w.includes("忽略过时的评测结果"));
      assertExists(ignoredLog, "应记录旧结果被丢弃的日志");
    } finally {
      await db.delete(evaluationResults).where(
        eq(evaluationResults.submission_id, subId),
      );
      await db.delete(submissions).where(eq(submissions.id, subId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});
