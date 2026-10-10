/**
 * 批任务 worker 原语测试（Handbook §5.7）。
 *
 * 覆盖：SKIP LOCKED 领取与 lease、过期 lease 回收、派发状态条件更新
 * （结果早到时不回退终态）、条目终态幂等、指数退避与超限失败、
 * 队列容量不足重新排队（不计失败）、结果回写时自动完成条目并聚合任务状态。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  claimJobItems,
  completeJobItem,
  DISPATCH_BACKOFF_SECONDS,
  listActiveJobItems,
  markJobItemDispatched,
  renewJobItemLease,
  requeueExpiredLeases,
  requeueJobItem,
  scheduleDispatchRetryOrFail,
} from "../../services/versioning/job-worker.ts";
import { applyAttemptResult } from "../../services/versioning/result-write.ts";
import { getRejudgeJob } from "../../services/versioning/rejudge-jobs.ts";

const now = new Date().toISOString();

await getDb().insert(users).values({
  id: "jw-admin",
  username: "jw-admin",
  email: "jw-admin@test.noj",
  password_hash: "hash",
  created_at: now,
  updated_at: now,
});

/** 建一个含 n 个 pending 条目的任务。 */
async function seedJob(jobId: string, itemCount: number): Promise<string[]> {
  const db = getDb();
  await db.insert(submissionJobs).values({
    id: jobId,
    kind: "rejudge",
    actor_id: "jw-admin",
    idempotency_key: `key-${jobId}`,
    request_hash: "hash",
    request: {},
    status: "queued",
    created_at: now,
  });
  const ids: string[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    const id = `${jobId}-item-${index}`;
    ids.push(id);
    await db.insert(submissionJobItems).values({
      id,
      job_id: jobId,
      ordinal: index,
      source_kind: "submission",
      source_id: `src-${index}`,
      problem_id: `prob-${index}`,
      target_version_id: null,
      status: "pending",
      created_at: now,
    });
  }
  return ids;
}

/** 建题 + 版本（每个用例都需自建：测试事务逐用例回滚）。 */
async function seedProblemAndVersion(): Promise<void> {
  const db = getDb();
  await db.insert(problems).values({
    id: "jw-prob",
    title: "jw",
    description: "d",
    type: "P",
    number: 994001,
    owner_id: "0",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: "jw-prob-v1",
    problem_id: "jw-prob",
    version: 1,
    origin: "published",
    content: { kind: "ai", title: "jw" },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: "jw-prob-v1" }).where(
    eq(problems.id, "jw-prob"),
  );
}

/** 建一条已知提交时版本的提交流（题目需已存在）。 */
async function seedSubmissionForJob(id: string): Promise<void> {
  await getDb().insert(submissions).values({
    id,
    user_id: "0",
    problem_id: "jw-prob",
    language: "python",
    code: "x",
    submitted_version_id: "jw-prob-v1",
    version_origin: "known",
    created_at: now,
  });
}

/** 建一次尝试（供条目 attempt_id 外键引用）。 */
async function seedAttemptRow(
  attemptId: string,
  submissionId: string,
  sequence = 0,
): Promise<void> {
  await getDb().insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: "jw-prob",
    problem_version_id: "jw-prob-v1",
    sequence,
    source: "rejudge",
    state: "queued",
    created_at: now,
  });
}

Deno.test("worker: 领取设置 preparing 与 lease，重复领取不重复派发", async () => {
  const db = getDb();
  await seedJob("jw-job-1", 3);
  const claimed = await claimJobItems("worker-a", { limit: 2 });
  assertEquals(claimed.length, 2);
  assertEquals(claimed.map((item) => item.ordinal), [0, 1]);

  // 同一次 lease 内不再被领取
  const second = await claimJobItems("worker-b", { limit: 10 });
  assertEquals(second.length, 1);
  assertEquals(second[0].ordinal, 2);

  const rows = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, "jw-job-1"),
  );
  assertEquals(rows.every((row) => row.status === "preparing"), true);
  assertEquals(rows[0].lease_owner, "worker-a");
  assertEquals(rows[2].lease_owner, "worker-b");
});

Deno.test("worker: lease 过期后可回收并重新领取（崩溃恢复）", async () => {
  const db = getDb();
  await seedJob("jw-job-2", 1);
  const claimed = await claimJobItems("worker-a");
  assertEquals(claimed.length, 1);

  // 未过期：回收 0 条
  assertEquals(await requeueExpiredLeases(), 0);

  // 人为把 lease 设为过期
  await db.update(submissionJobItems).set({
    lease_until: "2000-01-01T00:00:00.000Z",
  }).where(eq(submissionJobItems.id, claimed[0].id));
  assertEquals(await requeueExpiredLeases(), 1);
  const [row] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, claimed[0].id),
  );
  assertEquals(row.status, "pending");
  assertEquals(row.lease_owner, null);

  // 可以被其他 worker 重新领取
  const reclaimed = await claimJobItems("worker-b");
  assertEquals(reclaimed.length, 1);
  assertEquals(reclaimed[0].id, claimed[0].id);
});

Deno.test("worker: 派发条件更新不允许回退终态", async () => {
  await seedJob("jw-job-3", 1);
  const [item] = await claimJobItems("worker-a");
  // 结果比派发状态更新更早到达
  assertEquals(
    await completeJobItem(item.id, { status: "succeeded" }),
    true,
  );
  // 后续派发更新不得把 succeeded 改回 dispatched
  assertEquals(
    await markJobItemDispatched(item.id, "attempt-x", "worker-a"),
    false,
  );
  const [row] = await getDb().select().from(submissionJobItems).where(
    eq(submissionJobItems.id, item.id),
  );
  assertEquals(row.status, "succeeded");
  assertEquals(row.attempt_id, null);
});

Deno.test("worker: 续租与派发（仅 lease 持有者可派发）", async () => {
  await seedProblemAndVersion();
  await seedSubmissionForJob("jw-sub-renew");
  await seedAttemptRow("attempt-1", "jw-sub-renew");
  await seedJob("jw-job-4", 1);
  const [item] = await claimJobItems("worker-a");
  assertEquals(await renewJobItemLease(item.id, "worker-b"), false);
  assertEquals(await renewJobItemLease(item.id, "worker-a"), true);
  assertEquals(
    await markJobItemDispatched(item.id, "attempt-1", "worker-b"),
    false,
  );
  assertEquals(
    await markJobItemDispatched(item.id, "attempt-1", "worker-a"),
    true,
  );
  const [row] = await getDb().select().from(submissionJobItems).where(
    eq(submissionJobItems.id, item.id),
  );
  assertEquals(row.status, "dispatched");
  assertEquals(row.attempt_id, "attempt-1");
});

Deno.test("worker: 条目终态幂等", async () => {
  await seedJob("jw-job-5", 1);
  const ids = await seedJob("jw-job-5b", 1);
  assertEquals(
    await completeJobItem(ids[0], { status: "failed", reasonCode: "X" }),
    true,
  );
  assertEquals(
    await completeJobItem(ids[0], { status: "succeeded" }),
    false,
  );
  const [row] = await getDb().select().from(submissionJobItems).where(
    eq(submissionJobItems.id, ids[0]),
  );
  assertEquals(row.status, "failed");
  assertEquals(row.reason_code, "X");
});

Deno.test("worker: 派发失败按 1/2/4/8/16 退避，超限标记 failed", async () => {
  const db = getDb();
  const [itemId] = await seedJob("jw-job-6", 1);
  for (
    let attempt = 0;
    attempt < DISPATCH_BACKOFF_SECONDS.length;
    attempt += 1
  ) {
    const queued = await scheduleDispatchRetryOrFail(itemId, {
      reasonCode: "MQ_UNAVAILABLE",
      reasonMessage: "网络派发失败",
    });
    assertEquals(queued, true);
    const [row] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, itemId),
    );
    assertEquals(row.status, "pending");
    assertEquals(row.dispatch_retries, attempt + 1);
    assertEquals(row.next_dispatch_at !== null, true);
    // 清掉 next_dispatch_at 让下次仍可重试（这里只验证退避计数与状态机）
    await db.update(submissionJobItems).set({ next_dispatch_at: null }).where(
      eq(submissionJobItems.id, itemId),
    );
  }
  const failed = await scheduleDispatchRetryOrFail(itemId, {
    reasonCode: "MQ_UNAVAILABLE",
    reasonMessage: "超过最大重试次数",
  });
  assertEquals(failed, false);
  const [row] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, itemId),
  );
  assertEquals(row.status, "failed");
  assertEquals(row.reason_code, "MQ_UNAVAILABLE");
});

Deno.test("worker: 队列容量不足重新排队不计失败", async () => {
  const db = getDb();
  const [itemId] = await seedJob("jw-job-7", 1);
  await claimJobItems("worker-a");
  await requeueJobItem(itemId, 5);
  const [row] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, itemId),
  );
  assertEquals(row.status, "pending");
  assertEquals(row.dispatch_retries, 0);
  assertEquals(row.lease_owner, null);
});

Deno.test("worker: 结果回写自动完成条目并聚合任务状态", async () => {
  const db = getDb();
  await seedProblemAndVersion();
  await seedSubmissionForJob("jw-sub");
  await seedJob("jw-job-8", 1);
  await db.update(submissionJobItems).set({
    source_id: "jw-sub",
    problem_id: "jw-prob",
    target_version_id: "jw-prob-v1",
  }).where(eq(submissionJobItems.job_id, "jw-job-8"));

  // 建尝试并派发
  const attemptId = "jw-attempt-1";
  await db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: "jw-sub",
    problem_id: "jw-prob",
    problem_version_id: "jw-prob-v1",
    sequence: 0,
    source: "rejudge",
    state: "queued",
    created_at: now,
  });
  await db.update(submissions).set({ active_attempt_id: attemptId }).where(
    eq(submissions.id, "jw-sub"),
  );
  const [itemId] = await db.select({ id: submissionJobItems.id })
    .from(submissionJobItems).where(
      eq(submissionJobItems.job_id, "jw-job-8"),
    );
  await db.update(submissionJobItems).set({
    status: "dispatched",
    attempt_id: attemptId,
  }).where(eq(submissionJobItems.id, itemId.id));

  // 正式判定（WA 也是成功完成）
  await applyAttemptResult({
    attemptId,
    resultKind: "graded",
    resultStatus: "finished",
    score: 0,
    accepted: false,
    details: {},
  });
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, itemId.id),
  );
  assertEquals(item.status, "succeeded");
  const job = await getRejudgeJob("jw-job-8");
  assertEquals(job?.status, "completed");
  assertEquals(job?.counts.succeeded, 1);
  assertEquals(await listActiveJobItems("jw-job-8"), []);
});

Deno.test("worker: 平台错误把条目标记 failed 并保留原因码", async () => {
  const db = getDb();
  await seedProblemAndVersion();
  await seedSubmissionForJob("jw-sub-2");
  await seedJob("jw-job-9", 1);
  await db.update(submissionJobItems).set({
    source_id: "jw-sub-2",
    problem_id: "jw-prob",
  }).where(
    and(
      eq(submissionJobItems.job_id, "jw-job-9"),
      eq(submissionJobItems.ordinal, 0),
    ),
  );
  const attemptId = "jw-attempt-2";
  await db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: "jw-sub-2",
    problem_id: "jw-prob",
    problem_version_id: "jw-prob-v1",
    sequence: 1,
    source: "rejudge",
    state: "queued",
    created_at: now,
  });
  await db.update(submissions).set({ active_attempt_id: attemptId }).where(
    eq(submissions.id, "jw-sub-2"),
  );
  await db.update(submissionJobItems).set({
    status: "dispatched",
    attempt_id: attemptId,
  }).where(eq(submissionJobItems.job_id, "jw-job-9"));

  await applyAttemptResult({
    attemptId,
    resultKind: "platform_error",
    resultStatus: "SystemError",
    score: null,
    accepted: false,
    output: "镜像启动失败",
  });
  const rows = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, "jw-job-9"),
  );
  assertEquals(rows[0].status, "failed");
  assertEquals(rows[0].reason_code, "PLATFORM_ERROR");
  const job = await getRejudgeJob("jw-job-9");
  assertEquals(job?.status, "completed_with_errors");
});
