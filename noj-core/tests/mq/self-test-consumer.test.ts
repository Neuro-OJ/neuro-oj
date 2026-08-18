import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  evaluationResults,
  problems,
  selfTests,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { handleResultMessage } from "../../src/mq/consumer.ts";
import { recoverPendingSelfTests } from "../../src/mq/sweeper.ts";
import { SELF_TEST_ID_PREFIX } from "../../src/types/self-tests.ts";

const skip = false;

const ts = Date.now();
const USER_ID = `tst-consumer-st-user-${ts}`;
const PROBLEM_ID = `tst-consumer-st-problem-${ts}`;
const SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
const SUBMISSION_ID = `tst-consumer-st-sub-${ts}`;
const BAD_PROBLEM_ID = `tst-consumer-st-bad-problem-${ts}`;
const PENDING_SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
const now = new Date().toISOString();
const oldNow = new Date(Date.now() - 3 * 60_000).toISOString();

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
  name: "mq/consumer self-test: 初始化数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    await db.insert(users).values({
      id: USER_ID,
      username: `tstcst-${ts}`,
      email: `tstcst-${ts}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values([
      {
        id: PROBLEM_ID,
        title: "消费者自测题",
        description: "test",
        difficulty: "easy",
        runtime_config: runtimeConfig,
        number: 95000 + (ts % 10000),
        owner_id: USER_ID,
        type: "P",
        created_at: now,
        updated_at: now,
      },
      {
        id: BAD_PROBLEM_ID,
        title: "缺少 runtime_config 的题",
        description: "test",
        difficulty: "easy",
        runtime_config: null,
        number: 96000 + (ts % 10000),
        owner_id: USER_ID,
        type: "P",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(selfTests).values([
      {
        id: SELF_TEST_ID,
        user_id: USER_ID,
        problem_id: PROBLEM_ID,
        language: "python3",
        code: "print('hi')",
        status: "judging",
        created_at: now,
      },
      {
        id: PENDING_SELF_TEST_ID,
        user_id: USER_ID,
        problem_id: BAD_PROBLEM_ID,
        language: "python3",
        code: "print('bad')",
        status: "pending",
        created_at: oldNow,
      },
    ]);
    await db.insert(submissions).values({
      id: SUBMISSION_ID,
      user_id: USER_ID,
      problem_id: PROBLEM_ID,
      status: "judging",
      language: "python3",
      code: "print('hi')",
      created_at: now,
    });
  },
});

Deno.test({
  name: "mq/consumer self-test: st_ 前缀结果写入 self_tests 且不写正式表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await handleResultMessage({
      submission_id: SELF_TEST_ID,
      status: "Accepted",
      score: 10000,
      output: "---RESULT---\n{}",
      details: { cases: [] },
      time_ms: 12,
      memory_kb: 1024,
    });

    const db = getDb();
    const [st] = await db
      .select()
      .from(selfTests)
      .where(eq(selfTests.id, SELF_TEST_ID))
      .limit(1);
    assertEquals(st.status, "finished");
    assertEquals(st.result_status, "Accepted");
    assertEquals(st.score, 10000);

    const [er] = await db
      .select({ id: evaluationResults.id })
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, SELF_TEST_ID))
      .limit(1);
    assertEquals(er, undefined);
  },
});

Deno.test({
  name: "mq/consumer self-test: 非 st_ 前缀结果写入正式表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await handleResultMessage({
      submission_id: SUBMISSION_ID,
      status: "Accepted",
      score: 1000,
      output: "---RESULT---\n{}",
      details: {},
    });

    const db = getDb();
    const [er] = await db
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.submission_id, SUBMISSION_ID))
      .limit(1);
    assertEquals(er.status, "Accepted");
  },
});

Deno.test({
  name: "mq/consumer self-test: 重复自测终态结果幂等忽略",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await handleResultMessage({
      submission_id: SELF_TEST_ID,
      status: "WrongAnswer",
      score: 0,
      output: "---RESULT---\n{}",
      details: {},
    });

    const db = getDb();
    const [st] = await db
      .select()
      .from(selfTests)
      .where(eq(selfTests.id, SELF_TEST_ID))
      .limit(1);
    assertEquals(st.result_status, "Accepted");
    assertEquals(st.score, 10000);
  },
});

Deno.test({
  name: "mq/consumer self-test: pending 自测缺少 runtime_config 被标记 error",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await recoverPendingSelfTests(Date.now());

    const db = getDb();
    const [row] = await db
      .select()
      .from(selfTests)
      .where(eq(selfTests.id, PENDING_SELF_TEST_ID))
      .limit(1);
    assertEquals(row.status, "error");
  },
});

Deno.test({
  name: "mq/consumer self-test: 清理数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(evaluationResults).where(
      eq(evaluationResults.submission_id, SUBMISSION_ID),
    );
    await db.delete(submissions).where(eq(submissions.id, SUBMISSION_ID));
    await db.delete(selfTests).where(
      eq(selfTests.id, SELF_TEST_ID),
    );
    await db.delete(selfTests).where(
      eq(selfTests.id, PENDING_SELF_TEST_ID),
    );
    await db.delete(problems).where(eq(problems.id, PROBLEM_ID));
    await db.delete(problems).where(eq(problems.id, BAD_PROBLEM_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
  },
});
