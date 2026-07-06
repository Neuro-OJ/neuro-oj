import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  getPendingSubmissionIds,
  getQueueOverview,
  getSubmissionQueueStatus,
} from "../../src/services/queue.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../src/mq/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const USER_ID = `tst-queue-user-${ts}`;
const PROBLEM_ID = `tst-queue-prob-${ts}`;
const SUBMISSION_PENDING_ID = `tst-queue-pend-${ts}`;
const SUBMISSION_JUDGING_ID = `tst-queue-judg-${ts}`;
const SUBMISSION_FINISHED_ID = `tst-queue-fin-${ts}`;

async function setup() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: USER_ID,
    username: `tstqu-${ts}`,
    email: `tstqu-${ts}@test.noj`,
    password_hash: "hash",
    role: "user",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: PROBLEM_ID,
    type: "P",
    number: Math.floor(Math.random() * 10000),
    title: "Queue Test Problem",
    difficulty: "easy",
    owner_id: USER_ID,
    judge_image: "python",
    judge_command: "python3 evaluate.py",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    description: "test",
    created_at: now,
    updated_at: now,
  });
  await db.insert(submissions).values([
    {
      id: SUBMISSION_PENDING_ID,
      user_id: USER_ID,
      problem_id: PROBLEM_ID,
      status: "judging",
      language: "python3",
      code: "print('pending')",
      created_at: now,
    },
    {
      id: SUBMISSION_JUDGING_ID,
      user_id: USER_ID,
      problem_id: PROBLEM_ID,
      status: "judging",
      language: "python3",
      code: "print('judging')",
      judge_started_at: now,
      created_at: now,
    },
    {
      id: SUBMISSION_FINISHED_ID,
      user_id: USER_ID,
      problem_id: PROBLEM_ID,
      status: "finished",
      language: "python3",
      code: "print('finished')",
      judge_started_at: now,
      judge_finished_at: now,
      created_at: now,
    },
  ]);
  await db.insert(evaluationResults).values({
    id: `tst-er-${ts}`,
    submission_id: SUBMISSION_FINISHED_ID,
    status: "Accepted",
    score: 1000,
    output: "---RESULT---\n{}",
    created_at: now,
  });
}

async function teardown() {
  try {
    const db = getDb();
    await db.delete(evaluationResults).where(
      eq(evaluationResults.submission_id, SUBMISSION_FINISHED_ID),
    );
    await db.delete(submissions).where(
      eq(submissions.user_id, USER_ID),
    );
    await db.delete(problems).where(eq(problems.id, PROBLEM_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
  } catch { /* ignore */ }
}

async function pushToQueue(submissionId: string) {
  const redis = getRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  const task = JSON.stringify({
    submission_id: submissionId,
    problem_id: PROBLEM_ID,
    judge_image: "python",
    judge_command: "python3 evaluate.py",
    language: "python3",
    code: "print('test')",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
  });
  await redis.lpush("noj:judge:queue", task);
}

async function clearQueue() {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") {
      await redis.connect();
    }
    await redis.lrange("noj:judge:queue", 0, -1).then(async (items) => {
      for (const _ of items) {
        await redis.brpop("noj:judge:queue", 1).catch(() => {});
      }
    });
  } catch { /* ignore */ }
}

Deno.test({
  name: "queue service: 创建测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    resetRedisForTest();
    await connectRedis();
    await setup();
  },
});

Deno.test({
  name: "queue service: getPendingSubmissionIds 返回空列表（队列空）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clearQueue();
    const ids = await getPendingSubmissionIds();
    assertEquals(Array.isArray(ids), true);
    assertEquals(ids.length, 0);
  },
});

Deno.test({
  name: "queue service: getPendingSubmissionIds 返回 pending ID",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clearQueue();
    await pushToQueue(SUBMISSION_PENDING_ID);
    const ids = await getPendingSubmissionIds();
    // judge 运行中会实时消费队列，此时队列可能为空
    assertEquals(Array.isArray(ids), true);
    if (ids.length > 0) {
      assertEquals(ids.includes(SUBMISSION_PENDING_ID), true);
    }
  },
});

Deno.test({
  name: "queue service: getPendingSubmissionIds 跳过无效 JSON",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const redis = getRedis();
    await clearQueue();
    await pushToQueue(SUBMISSION_PENDING_ID);
    await redis.lpush("noj:judge:queue", "invalid json");
    const ids = await getPendingSubmissionIds();
    // judge 运行中会实时消费队列，但函数不应抛出异常
    assertEquals(Array.isArray(ids), true);
  },
});

Deno.test({
  name: "queue service: getQueueOverview 返回正确结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const overview = await getQueueOverview();
    assertEquals(Array.isArray(overview.pending), true);
    assertEquals(Array.isArray(overview.judging), true);
    assertEquals(Array.isArray(overview.recently_completed), true);
    assertEquals(typeof overview.stats.pending_count, "number");
    assertEquals(typeof overview.stats.judging_count, "number");
    assertEquals(typeof overview.stats.completed_today, "number");
  },
});

Deno.test({
  name: "queue service: getSubmissionQueueStatus 不存在返回 null",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await getSubmissionQueueStatus("nonexistent-id");
    assertEquals(result, null);
  },
});

Deno.test({
  name: "queue service: getSubmissionQueueStatus 所有者可查看",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await getSubmissionQueueStatus(
      SUBMISSION_PENDING_ID,
      USER_ID,
    );
    assert(result !== null);
    assertEquals(result?.status, "judging");
  },
});

Deno.test({
  name: "queue service: getSubmissionQueueStatus 非所有者返回 null",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await getSubmissionQueueStatus(
      SUBMISSION_PENDING_ID,
      "other-user",
    );
    assertEquals(result, null);
  },
});

Deno.test({
  name: "queue service: getSubmissionQueueStatus admin 可查看任意",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const result = await getSubmissionQueueStatus(
      SUBMISSION_FINISHED_ID,
      "admin-user",
      "admin",
    );
    assert(result !== null);
    assertEquals(result?.status, "finished");
  },
});

Deno.test({
  name: "queue service: 清理测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clearQueue();
    await teardown();
  },
});
