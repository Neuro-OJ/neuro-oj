import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";

import {
  evaluationResults,
  problems,
  selfTests,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { handleResultMessage } from "../../mq/consumer.ts";
import {
  recoverPendingSelfTests,
  recoverPendingSubmissions,
} from "../../mq/sweeper.ts";
import { JUDGE_QUEUES } from "../../mq/producer.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "./_setup.ts";
import { SELF_TEST_ID_PREFIX } from "../../types/self-tests.ts";

const skip = false;

const ts = Date.now();
const USER_ID = `tst-consumer-st-user-${ts}`;
const PROBLEM_ID = `tst-consumer-st-problem-${ts}`;
const SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
const SUBMISSION_ID = `tst-consumer-st-sub-${ts}`;
const BAD_PROBLEM_ID = `tst-consumer-st-bad-problem-${ts}`;
const PENDING_SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
const RECOVERABLE_SELF_TEST_ID = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
const RECOVERABLE_SUBMISSION_ID = `tst-consumer-st-recover-sub-${ts}`;
const INVALID_SUBMISSION_ID = `tst-consumer-st-invalid-sub-${ts}`;
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

// 模块级 setup：事务外初始化共享数据
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
  {
    id: RECOVERABLE_SELF_TEST_ID,
    user_id: USER_ID,
    problem_id: PROBLEM_ID,
    language: "python3",
    code: "print('recover')",
    status: "pending",
    judge_started_at: oldNow,
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
await db.insert(submissions).values({
  id: RECOVERABLE_SUBMISSION_ID,
  user_id: USER_ID,
  problem_id: PROBLEM_ID,
  status: "pending",
  language: "python3",
  code: "print('recover')",
  created_at: oldNow,
});
await db.insert(submissions).values({
  id: INVALID_SUBMISSION_ID,
  user_id: USER_ID,
  problem_id: BAD_PROBLEM_ID,
  status: "pending",
  language: "python3",
  code: "print('invalid')",
  created_at: oldNow,
});

Deno.test({
  name: "mq/consumer self-test: st_ 前缀结果写入 self_tests 且不写正式表",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await handleResultMessage({
      submission_id: SELF_TEST_ID,
      status: "finished",
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
    assertEquals(st.result_status, "finished");
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
      status: "finished",
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
    assertEquals(er.status, "finished");
  },
});

Deno.test({
  name: "mq/consumer self-test: 重复自测终态结果幂等忽略",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 先产生一个终态 finished（本用例独立完成，不依赖上一个用例）
    await handleResultMessage({
      submission_id: SELF_TEST_ID,
      status: "finished",
      score: 10000,
      output: "---RESULT---\n{}",
      details: { cases: [] },
      time_ms: 12,
      memory_kb: 1024,
    });
    // 再发送重复终态，应被幂等忽略
    await handleResultMessage({
      submission_id: SELF_TEST_ID,
      status: "finished",
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
    assertEquals(st.result_status, "finished");
    assertEquals(st.score, 10000);
  },
});

Deno.test({
  name: "mq/consumer: 2 分钟后恢复 pending 正式提交",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();

      await recoverPendingSubmissions(Date.now());

      const db = getDb();
      const [row] = await db
        .select()
        .from(submissions)
        .where(eq(submissions.id, RECOVERABLE_SUBMISSION_ID))
        .limit(1);
      assertEquals(row.status, "judging");
    } finally {
      await fake.stop();
      resetRedisForTest();
      if (prevUrl !== null) {
        Deno.env.set("REDIS_URL", prevUrl);
      } else {
        Deno.env.delete("REDIS_URL");
      }
    }
  },
});

Deno.test({
  name: "mq/consumer: pending 恢复任务固定 submission_mode=code",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 回归：pending 恢复查询条件为 artifact_storage_url IS NULL，只可能承载
    // 代码提交。即便题目当前是 prediction，也必须以 code 入队，否则 judge
    // 会走 prediction 分支却拿不到预测文件而静默失败。
    const db = getDb();
    await db.update(problems).set({ submission_mode: "prediction" })
      .where(eq(problems.id, PROBLEM_ID));
    // 前置用例可能已把该行恢复为 judging，这里重置回 pending 复现恢复条件。
    await db.update(submissions).set({ status: "pending", created_at: oldNow })
      .where(eq(submissions.id, RECOVERABLE_SUBMISSION_ID));

    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();

      await recoverPendingSubmissions(Date.now());

      const messages = fake.getMessages(JUDGE_QUEUES.medium);
      assertEquals(messages.length >= 1, true, "应至少有恢复任务入队");
      const task = JSON.parse(messages[0]) as Record<string, unknown>;
      assertEquals(
        task.submission_mode,
        "code",
        "pending 恢复只承载代码提交，必须固定 code，不随题目当前模式漂移",
      );
      // 恢复后题目模式保持 prediction（本用例只读入队任务，不改题目语义）
      const [problem] = await db
        .select({ mode: problems.submission_mode })
        .from(problems)
        .where(eq(problems.id, PROBLEM_ID))
        .limit(1);
      assertEquals(problem.mode, "prediction");
    } finally {
      await db.update(problems).set({ submission_mode: "code" })
        .where(eq(problems.id, PROBLEM_ID));
      await fake.stop();
      resetRedisForTest();
      if (prevUrl !== null) {
        Deno.env.set("REDIS_URL", prevUrl);
      } else {
        Deno.env.delete("REDIS_URL");
      }
    }
  },
});

Deno.test({
  name:
    "mq/consumer self-test: 可恢复 pending 自测成功入队且保留 judge_started_at",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();

      await recoverPendingSelfTests(Date.now());

      const db = getDb();
      const [row] = await db
        .select()
        .from(selfTests)
        .where(eq(selfTests.id, RECOVERABLE_SELF_TEST_ID))
        .limit(1);
      assertEquals(row.status, "judging");
      assertEquals(row.judge_started_at, oldNow);
    } finally {
      await fake.stop();
      resetRedisForTest();
      if (prevUrl !== null) {
        Deno.env.set("REDIS_URL", prevUrl);
      } else {
        Deno.env.delete("REDIS_URL");
      }
    }
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
  name: "mq/consumer: pending 正式提交缺少 runtime_config 被标记 error",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await recoverPendingSubmissions(Date.now());

    const db = getDb();
    const [row] = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, INVALID_SUBMISSION_ID))
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
    await db.delete(submissions).where(
      eq(submissions.id, RECOVERABLE_SUBMISSION_ID),
    );
    await db.delete(submissions).where(
      eq(submissions.id, INVALID_SUBMISSION_ID),
    );
    await db.delete(selfTests).where(
      eq(selfTests.id, SELF_TEST_ID),
    );
    await db.delete(selfTests).where(
      eq(selfTests.id, PENDING_SELF_TEST_ID),
    );
    await db.delete(selfTests).where(
      eq(selfTests.id, RECOVERABLE_SELF_TEST_ID),
    );
    await db.delete(problems).where(eq(problems.id, PROBLEM_ID));
    await db.delete(problems).where(eq(problems.id, BAD_PROBLEM_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
  },
});
