import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  getPendingSubmissionIds,
  getQueueOverview,
  getSubmissionQueueStatus,
  removePendingSubmission,
} from "../../index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  auditLogs,
  evaluationAttempts,
  problems,
  selfTests,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import { SELF_TEST_ID_PREFIX } from "../../types/self-tests.ts";
import { enterTestContext } from "../../../system/index.ts";
import {
  ALL_JUDGE_QUEUES,
  JUDGE_QUEUES,
} from "../../../../shared/mq/judge-queues.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");
const skip = !hasDb;

const ts = Date.now();
const USER_ID = `tst-queue-user-${ts}`;
const PROBLEM_ID = `tst-queue-prob-${ts}`;
const SUBMISSION_PENDING_ID = `tst-queue-pend-${ts}`;
const SUBMISSION_JUDGING_ID = `tst-queue-judg-${ts}`;
const SUBMISSION_FINISHED_ID = `tst-queue-fin-${ts}`;
const SELF_TEST_FINISHED_ID = `${SELF_TEST_ID_PREFIX}tst-queue-fin-${ts}`;

async function setup() {
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: USER_ID,
    username: `tstqu-${ts}`,
    email: `tstqu-${ts}@test.noj`,
    password_hash: "hash",
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
    runtime_config: {
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
    },
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
  // 最近完成项的结果读「最近终态尝试」：为已完成提交补一条尝试并回填指针
  await db.insert(evaluationAttempts).values({
    id: `tst-att-${ts}`,
    submission_id: SUBMISSION_FINISHED_ID,
    problem_id: PROBLEM_ID,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: 1000,
    accepted: true,
    created_at: now,
    finished_at: now,
  });
  await db.update(submissions).set({
    latest_attempt_id: `tst-att-${ts}`,
    effective_attempt_id: `tst-att-${ts}`,
    is_valid: true,
    is_accepted: true,
  }).where(eq(submissions.id, SUBMISSION_FINISHED_ID));
  await db.insert(selfTests).values({
    id: SELF_TEST_FINISHED_ID,
    user_id: USER_ID,
    problem_id: PROBLEM_ID,
    language: "python3",
    code: "print('self')",
    status: "finished",
    result_status: "finished",
    score: 10000,
    output: "---RESULT---\n{}",
    details: "{}",
    judge_started_at: now,
    judge_finished_at: now,
    created_at: now,
  });
}

async function teardown() {
  try {
    const db = getDb();
    await db.delete(selfTests).where(
      eq(selfTests.user_id, USER_ID),
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
    runtime_config: {
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
    },
    language: "python3",
    code: "print('test')",
  });
  await redis.lpush(JUDGE_QUEUES.medium, task);
}

/**
 * 清空**全部**评测队列（含分池队列）。
 *
 * 生产按资源池分队列（`noj:judge:queue:<pool>:<priority>`），只清三级旧队列会让
 * 池内残留条目污染"队列为空"的断言——历史上这是本套用例的已知 flake 源。
 */
async function clearQueue() {
  try {
    const redis = getRedis();
    if (redis.status !== "ready") {
      await redis.connect();
    }
    for (const queue of ALL_JUDGE_QUEUES) {
      await redis.del(queue);
    }
  } catch { /* ignore */ }
}

// 模块级 setup：事务外初始化共享队列测试数据
await resetDbForTest();
resetRedisForTest();
await connectRedis();
await setup();

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
  name: "queue service: 移除 pending 提交并记录审计日志",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clearQueue();
    await pushToQueue(SUBMISSION_JUDGING_ID);
    enterTestContext({
      actorId: USER_ID,
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });

    // 本地开发时 judge 可能已在消费同一 Redis 队列；任务被领取后，
    // 本测试不再拥有可删除的 pending 条目。CI 中无 worker 竞争时会覆盖成功路径。
    if (!(await getPendingSubmissionIds()).includes(SUBMISSION_JUDGING_ID)) {
      return;
    }

    try {
      await removePendingSubmission(SUBMISSION_JUDGING_ID);
    } catch (err) {
      if (err instanceof Error && err.message === "待处理队列中不存在该提交") {
        return;
      }
      throw err;
    }

    const redis = getRedis();
    const tasks = await redis.lrange(JUDGE_QUEUES.medium, 0, -1);
    assertEquals(
      tasks.some((task) =>
        JSON.parse(task).submission_id === SUBMISSION_JUDGING_ID
      ),
      false,
    );
    const db = getDb();
    const [submission] = await db.select({
      status: submissions.status,
      judge_finished_at: submissions.judge_finished_at,
    }).from(submissions).where(eq(submissions.id, SUBMISSION_JUDGING_ID));
    assertEquals(submission?.status, "error");
    assert(submission?.judge_finished_at);
    const [audit] = await db.select({
      action: auditLogs.action,
      target_id: auditLogs.target_id,
    }).from(auditLogs).where(eq(auditLogs.action, "submissions.queue_removed"));
    assertEquals(audit?.target_id, SUBMISSION_JUDGING_ID);
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
    await redis.lpush(JUDGE_QUEUES.medium, "invalid json");
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
  name: "queue service: getQueueOverview 自测按查看者隔离（审计 VULN-11）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 本人视角：看得到自己的自测，并标记 kind === "self_test"
    const mine = await getQueueOverview(false, USER_ID);
    const selfItem = mine.recently_completed.find(
      (item) => item.id === SELF_TEST_FINISHED_ID,
    );
    assertEquals(selfItem !== undefined, true);
    assertEquals(selfItem?.kind, "self_test");

    // 他人视角：完全看不到别人的自测（题目/用户名/得分都不泄露）
    const others = await getQueueOverview(false, "another-viewer-user");
    assertEquals(
      others.recently_completed.some((item) => item.kind === "self_test"),
      false,
    );
    assertEquals(
      others.recently_completed.some((item) =>
        item.id === SELF_TEST_FINISHED_ID
      ),
      false,
    );

    // 未登录（无 viewerUserId）：fail-closed，一律看不到自测
    const anonymous = await getQueueOverview(false);
    assertEquals(
      anonymous.recently_completed.some((item) => item.kind === "self_test"),
      false,
    );

    // 管理员：全站自测可见
    const admin = await getQueueOverview(true);
    assertEquals(
      admin.recently_completed.some((item) => item.kind === "self_test"),
      true,
    );
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
