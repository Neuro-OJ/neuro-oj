import {
  acceptLegacyRejudgeJobForTest as acceptRejudgeJob,
  authorizeLegacyJobActorForTest,
} from "../_versioning-fixtures.ts";
/**
 * 批任务并发与租约回归（tracking #34、#36、#37）。
 *
 * - #37 双 worker + 租约过期：过期 worker 的**任何**写入（续租、派发状态、终态、
 *   重新排队）都必须被拒，不能覆盖新持有者；执行期间必须持续续租（心跳）。
 * - #34 派发失败重试复用自身活动尝试：队列容量不足重新排队后，下一轮不得把
 *   「本条目自己的在途尝试」当成外部评测而 `skipped`。
 * - #36 升级派发重试只新增 1 条提交：连续队列满与再次派发后，
 *   实际新增提交数必须仍为 1（复用 `result_submission_id` 与尝试）。
 *
 * 本文件的租约/双 worker 用例在 PGlite 下以「同一连接的顺序竞争」模拟两个 worker
 * （写条件全部是数据库条件更新，语义等价）；文件末的**双边并发领取**用例只有真实
 * PostgreSQL 才具备并发语义，无 DATABASE_URL 时跳过。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  disableTestTransactionForFile,
  getDb,
} from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  judgeImages,
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
  markJobItemDispatched,
  renewJobItemLease,
  requeueExpiredLeases,
  requeueJobItem,
  startJobItemLeaseHeartbeat,
} from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { refreshJobStatus } from "../../services/versioning/rejudge-jobs.ts";
import { acceptUpgradeJob } from "../../services/versioning/upgrade-jobs.ts";
import { JUDGE_QUEUE_CAPACITY } from "../../mq/producer.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";

const now = new Date().toISOString();

// 真实 PG（独立 schema）由迁移创建，不含 PGlite 的 root 种子；
// 用例把 `owner_id` 指向 "0"，因此这里幂等补一行（PGlite 下已存在，无副作用）。
await getDb().insert(users).values({
  id: "0",
  username: "root",
  email: "root@noj.local",
  password_hash: "",
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();

// 真实 PG（独立 schema）不含 PGlite 的评测镜像种子：白名单为空会让所有派发被
// 预检拒绝（JUDGE_IMAGE_NOT_ALLOWED），因此这里幂等补上两条（PGlite 下已存在）。
await getDb().insert(judgeImages).values([
  {
    id: "e0000000-0000-0000-0000-000000000002",
    image: "noj-evaluator-python",
    mode: "all_versions",
    kind: "evaluator",
    description: "测试 Evaluator",
    created_at: now,
    updated_at: now,
  },
  {
    id: "e0000000-0000-0000-0000-000000000003",
    image: "noj-solution-python",
    mode: "all_versions",
    kind: "solution",
    description: "测试 Solution",
    created_at: now,
    updated_at: now,
  },
]).onConflictDoNothing();

const db = getDb();
const ts = Date.now();

/** 需要真实 PostgreSQL 的并发语义（PGlite 单连接无法并行）。 */
const hasRealPg = !!Deno.env.get("DATABASE_URL");

/**
 * 本文件在真实 PG 下关闭 preload 事务（并发用例需要真实事务），因此必须**显式清理**
 * 自己创建的夹具：否则残留行会污染同一 schema 上的其它用例与后续运行。
 * 各 seed 辅助函数把 id 登记到这里，文件末尾的统一清理用例负责删除。
 */
const createdFixtures = {
  userIds: new Set<string>(),
  problemIds: new Set<string>(),
  submissionIds: new Set<string>(),
  jobIds: new Set<string>(),
};

// 真实 PG 下的两个并发用例必须各自持有真实事务（preload 的单连接 savepoint
// 代理无法承载 `Promise.all` 的并发事务，会报 "savepoint ... does not exist"）。
// 本文件所有夹具使用 `ts` 唯一 ID，关闭事务包装不会与其他用例互相污染。
if (hasRealPg) disableTestTransactionForFile();

const dualConfig = (timeLimitMs: number) => ({
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: timeLimitMs,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
});

async function makeUser(tag: string): Promise<string> {
  const id = `conc-user-${tag}-${ts}`;
  createdFixtures.userIds.add(id);
  await db.insert(users).values({
    id,
    username: `conc-${tag}-${ts}`,
    email: `conc-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await authorizeLegacyJobActorForTest(id);
  return id;
}

/** 建题 + V1/V2（latest = V2）。 */
async function seedProblemWithVersions(
  tag: string,
): Promise<{ problemId: string; v1: string; v2: string }> {
  const problemId = `conc-prob-${tag}-${ts}`;
  const v1 = `conc-v1-${tag}-${ts}`;
  const v2 = `conc-v2-${tag}-${ts}`;
  createdFixtures.problemIds.add(problemId);
  await db.insert(problems).values({
    id: problemId,
    title: `并发测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 98500 + Math.floor(Math.random() * 1000),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: dualConfig(1111),
    created_at: now,
    updated_at: now,
  });
  const content = (title: string) => ({
    kind: "ai",
    title,
    description: "d",
    samples: [],
    submission_mode: "code",
    runtime_config: dualConfig(1111),
    template_content: "",
    artifact_max_size_mb: null,
    llm_config: null,
  });
  await db.insert(problemVersions).values([
    {
      id: v1,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: content("V1"),
      published_at: now,
    },
    {
      id: v2,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: content("V2"),
      published_at: now,
    },
  ]);
  await db.update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, problemId),
  );
  return { problemId, v1, v2 };
}

/** 建提交 + 初次尝试（sequence 0）。 */
async function seedSubmission(
  problemId: string,
  userId: string,
  versionId: string,
): Promise<{ submissionId: string; attemptId: string }> {
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  createdFixtures.submissionIds.add(submissionId);
  await db.insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
  });
  await db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: problemId,
    problem_version_id: versionId,
    sequence: 0,
    source: "initial",
    state: "finished",
    created_at: now,
  });
  return { submissionId, attemptId };
}

/**
 * 领取**本任务**的条目。
 *
 * PG 下多个测试文件可能共享同一隔离 schema（并行 worker），因此领取结果里
 * 可能混入其他用例已提交的条目：这里一并领取后按 jobId 过滤，避免误判。
 */
async function claimOwnItem(
  owner: string,
  jobId: string,
  options: { leaseSeconds?: number } = {},
) {
  const claimed = await claimJobItems(owner, {
    limit: 100,
    ...(options.leaseSeconds !== undefined
      ? { leaseSeconds: options.leaseSeconds }
      : {}),
  });
  const [mine] = claimed.filter((item) => item.job_id === jobId);
  assertEquals(mine !== undefined, true, "未领取到本任务条目");
  return mine;
}

async function loadItem(jobId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  );
  return item;
}

/** 计数：某源提交产生的升级副本。 */
async function countUpgradedFrom(sourceId: string): Promise<number> {
  const rows = await db.select({ id: submissions.id }).from(submissions).where(
    eq(submissions.upgraded_from_id, sourceId),
  );
  return rows.length;
}

Deno.test("worker#37: 租约过期换主后，旧 worker 的所有写入均被拒", async () => {
  await makeUser("lease");
  const { problemId, v1 } = await seedProblemWithVersions("lease");
  const { submissionId } = await seedSubmission(problemId, "0", v1);
  const jobId = `conc-lease-job-${ts}`;
  createdFixtures.jobIds.add(jobId);
  await db.insert(submissionJobs).values({
    id: jobId,
    kind: "rejudge",
    actor_id: "conc-user-lease-" + ts,
    idempotency_key: `conc-lease-key-${ts}`,
    request_hash: "h",
    request: {},
    status: "queued",
    created_at: now,
  });
  const itemId = `conc-lease-item-${ts}`;
  await db.insert(submissionJobItems).values({
    id: itemId,
    job_id: jobId,
    ordinal: 0,
    source_kind: "submission",
    source_id: submissionId,
    problem_id: problemId,
    target_version_id: v1,
    target_version_ref: v1,
    status: "pending",
    created_at: now,
  });

  // worker A 领取
  const claimedA = await claimOwnItem("worker-A", jobId);
  assertEquals(claimedA.id, itemId);
  assertEquals((await loadItem(jobId)).lease_owner, "worker-A");

  // 租约过期 → 回收 → worker B 接管
  await db.update(submissionJobItems).set({
    lease_until: "2000-01-01T00:00:00.000Z",
  }).where(eq(submissionJobItems.id, itemId));
  assertEquals(await requeueExpiredLeases(), 1);
  assertEquals((await loadItem(jobId)).status, "pending");
  assertEquals((await loadItem(jobId)).lease_owner, null);

  const claimedB = await claimOwnItem("worker-B", jobId);
  assertEquals(claimedB.id, itemId);
  const held = await loadItem(jobId);
  assertEquals(held.status, "preparing");
  assertEquals(held.lease_owner, "worker-B");

  // 旧 worker A 的写入全部被拒
  assertEquals(await renewJobItemLease(itemId, "worker-A"), false);
  assertEquals(
    await markJobItemDispatched(itemId, "attempt-x", "worker-A"),
    false,
  );
  assertEquals(
    await completeJobItem(itemId, {
      status: "succeeded",
      leaseOwner: "worker-A",
    }),
    false,
  );
  await requeueJobItem(itemId, 5, "worker-A");
  const after = await loadItem(jobId);
  assertEquals(after.status, "preparing");
  assertEquals(after.lease_owner, "worker-B");
  assertEquals(after.reason_code, null);

  // 新持有者仍可正常写入
  assertEquals(await renewJobItemLease(itemId, "worker-B"), true);
  assertEquals(
    await completeJobItem(itemId, {
      status: "succeeded",
      leaseOwner: "worker-B",
    }),
    true,
  );
  assertEquals((await loadItem(jobId)).status, "succeeded");
});

Deno.test({
  name: "worker#37: 执行期间心跳持续续租，租约丢失后心跳报告 lost",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const actor = await makeUser("hb");
    const { problemId, v1 } = await seedProblemWithVersions("hb");
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const jobId = `conc-hb-job-${ts}`;
    createdFixtures.jobIds.add(jobId);
    await db.insert(submissionJobs).values({
      id: jobId,
      kind: "rejudge",
      actor_id: actor,
      idempotency_key: `conc-hb-key-${ts}`,
      request_hash: "h",
      request: {},
      status: "queued",
      created_at: now,
    });
    const itemId = `conc-hb-item-${ts}`;
    await db.insert(submissionJobItems).values({
      id: itemId,
      job_id: jobId,
      ordinal: 0,
      source_kind: "submission",
      source_id: submissionId,
      problem_id: problemId,
      target_version_id: v1,
      target_version_ref: v1,
      status: "pending",
      created_at: now,
    });
    await claimOwnItem("hb-worker", jobId, { leaseSeconds: 30 });
    const before = (await loadItem(jobId)).lease_until as string;

    // 心跳间隔 20ms：等一个周期后租约必须被推进
    const heartbeat = startJobItemLeaseHeartbeat(itemId, "hb-worker", 20);
    assertEquals(heartbeat.lost(), false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const renewed = (await loadItem(jobId)).lease_until as string;
    assertEquals(renewed > before, true);
    assertEquals(heartbeat.lost(), false);

    // 另一个 worker 抢走租约后，心跳续租失败并报告 lost
    await db.update(submissionJobItems).set({ lease_owner: "hb-worker-2" })
      .where(eq(submissionJobItems.id, itemId));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(heartbeat.lost(), true);

    heartbeat.stop();
    const stopped = (await loadItem(jobId)).lease_until as string;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assertEquals((await loadItem(jobId)).lease_until, stopped);
  },
});

Deno.test({
  name: "dispatch#34: 队列容量不足重排后不得把自身在途尝试当成外部评测跳过",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("requeue");
    const { problemId, v1 } = await seedProblemWithVersions("requeue");
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const accepted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "latest" },
      },
      `conc-requeue-key-${ts}`,
    );
    const jobId = accepted.job_id;
    createdFixtures.jobIds.add(jobId);

    const itemId = (await loadItem(jobId)).id;

    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      // 队列容量占满：派发只能等待下轮
      fake.seedQueue(
        "noj:judge:queue:ai:low",
        JUDGE_QUEUE_CAPACITY.low,
      );

      const first = await claimOwnItem("requeue-worker", jobId);
      assertEquals(first.id, itemId);
      const firstOutcome = await dispatchJobItem(
        first,
        "requeue-worker",
        "rejudge",
      );
      assertEquals(firstOutcome, "deferred");
      const attemptId = (await loadItem(jobId)).attempt_id;
      assertEquals(typeof attemptId, "string");
      assertEquals((await loadItem(jobId)).status, "pending");
      // 源提交的活动尝试就是本条目的尝试（不是外部评测）
      const [source] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(source.active_attempt_id, attemptId);

      // 下一轮：必须复用自身尝试继续派发，绝不能 skipped + SOURCE_JUDGING
      await db.update(submissionJobItems).set({ next_dispatch_at: null }).where(
        eq(submissionJobItems.id, itemId),
      );
      const second = await claimOwnItem("requeue-worker-2", jobId);
      assertEquals(second.id, itemId);
      assertEquals(second.attempt_id, attemptId);
      const secondOutcome = await dispatchJobItem(
        second,
        "requeue-worker-2",
        "rejudge",
      );
      assertEquals(secondOutcome, "deferred");
      const item = await loadItem(jobId);
      assertEquals(item.attempt_id, attemptId);
      assertEquals(item.status, "pending");
      assertEquals(item.reason_code, null);
      // 只有一次重测尝试（seedSubmission 的初次尝试不计）
      const attempts = await db.select({
        id: evaluationAttempts.id,
        source: evaluationAttempts.source,
      }).from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, submissionId),
      );
      assertEquals(
        attempts.filter((row) => row.source === "rejudge").length,
        1,
      );
    } finally {
      // 先恢复全局 env / 单例，再停止 fake：避免"env 仍指向已停止服务器"的窗口
      // 被并行测试文件的 Redis 调用读到（额度调用会 fail-closed → 正常的升级派发
      // 被误判为延期）。
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "dispatch#36: 升级派发反复重试后只新增 1 条提交、1 条尝试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("up-retry");
    const { problemId, v1, v2 } = await seedProblemWithVersions("up-retry");
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const accepted = await acceptUpgradeJob(
      actor,
      {
        submissions: [{ kind: "submission", id: submissionId }],
        context: "practice",
      },
      `conc-up-retry-key-${ts}`,
    );
    const jobId = accepted.job_id;
    createdFixtures.jobIds.add(jobId);

    const itemId = (await loadItem(jobId)).id;

    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      // 队列满：每次派发都只能重新排队（模拟连续容量不足）
      fake.seedQueue(
        "noj:judge:queue:ai:medium",
        JUDGE_QUEUE_CAPACITY.medium,
      );

      let reusedAttemptId: string | null = null;
      let reusedSubmissionId: string | null = null;
      for (let round = 0; round < 3; round++) {
        if (round > 0) {
          await db.update(submissionJobItems).set({ next_dispatch_at: null })
            .where(eq(submissionJobItems.id, itemId));
        }
        const claimed = await claimOwnItem(
          `up-retry-worker-${round}`,
          jobId,
        );
        assertEquals(claimed.id, itemId);
        const outcome = await dispatchJobItem(
          claimed,
          `up-retry-worker-${round}`,
          "upgrade",
          "practice",
        );
        assertEquals(outcome, "deferred");
        const item = await loadItem(jobId);
        assertEquals(item.status, "pending");
        assertEquals(await countUpgradedFrom(submissionId), 1);
        if (reusedAttemptId === null) {
          reusedAttemptId = item.attempt_id;
          reusedSubmissionId = item.result_submission_id;
        } else {
          // 重试必须复用同一尝试与同一副本，不得再造提交或留下孤儿
          assertEquals(item.attempt_id, reusedAttemptId);
          assertEquals(item.result_submission_id, reusedSubmissionId);
        }
        assertEquals(typeof reusedAttemptId, "string");
        assertEquals(typeof reusedSubmissionId, "string");
      }

      // 队列恢复容量 → 成功派发，提交数仍为 1
      fake.clear();
      await db.update(submissionJobItems).set({ next_dispatch_at: null }).where(
        eq(submissionJobItems.id, itemId),
      );
      const finalClaim = await claimOwnItem("up-retry-final", jobId);
      assertEquals(finalClaim.id, itemId);
      const finalOutcome = await dispatchJobItem(
        finalClaim,
        "up-retry-final",
        "upgrade",
        "practice",
      );
      assertEquals(finalOutcome, "dispatched");
      const item = await loadItem(jobId);
      assertEquals(item.status, "dispatched");
      assertEquals(item.attempt_id, reusedAttemptId);
      assertEquals(item.result_submission_id, reusedSubmissionId);
      assertEquals(await countUpgradedFrom(submissionId), 1);

      const [created] = await db.select().from(submissions).where(
        eq(submissions.id, reusedSubmissionId as string),
      );
      assertEquals(created.upgraded_from_id, submissionId);
      assertEquals(created.submitted_version_id, v2);
      const attempts = await db.select({ id: evaluationAttempts.id }).from(
        evaluationAttempts,
      ).where(eq(evaluationAttempts.submission_id, created.id));
      assertEquals(attempts.length, 1);
      assertEquals(attempts[0].id, reusedAttemptId);
      // 原提交完全不动
      const [original] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(original.submitted_version_id, v1);
      assertEquals(original.upgraded_from_id, null);
    } finally {
      // 先恢复全局 env / 单例，再停止 fake：避免"env 仍指向已停止服务器"的窗口
      // 被并行测试文件的 Redis 调用读到（额度调用会 fail-closed → 正常的升级派发
      // 被误判为延期）。
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "dispatch#38: 网络派发失败按 1/2/4/8/16 退避，超限统一终结尝试与条目",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("netfail");
    const { problemId, v1 } = await seedProblemWithVersions("netfail");
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const accepted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "submitted" },
      },
      `conc-netfail-key-${ts}`,
    );
    const jobId = accepted.job_id;
    createdFixtures.jobIds.add(jobId);

    const itemId = (await loadItem(jobId)).id;

    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      // 指向拒绝连接的端口且不建立连接：pushJudgeTask 抛 network 类错误
      resetRedisForTest();
      Deno.env.set("REDIS_URL", "redis://127.0.0.1:1/");

      let attemptId: string | null = null;
      const outcomes: string[] = [];
      // 1 次首次派发 + 5 次退避重试 = 6 轮
      for (let round = 0; round <= DISPATCH_BACKOFF_SECONDS.length; round++) {
        if (round > 0) {
          await db.update(submissionJobItems).set({ next_dispatch_at: null })
            .where(eq(submissionJobItems.id, itemId));
        }
        const claimed = await claimOwnItem(
          `netfail-worker-${round}`,
          jobId,
        );
        assertEquals(claimed.id, itemId);
        const outcome = await dispatchJobItem(
          claimed,
          `netfail-worker-${round}`,
          "rejudge",
        );
        outcomes.push(outcome);
        const item = await loadItem(jobId);
        attemptId = attemptId ?? item.attempt_id;
        // 重试期间复用同一尝试（不重复建尝试、不重复计提交）
        assertEquals(item.attempt_id, attemptId);
      }
      // 前 5 轮为退避重试，第 6 轮达到上限后终结
      assertEquals(outcomes, [
        "retry",
        "retry",
        "retry",
        "retry",
        "retry",
        "retry",
      ]);
      const item = await loadItem(jobId);
      assertEquals(item.status, "failed");
      assertEquals(item.reason_code, "DISPATCH_FAILED");
      assertEquals(item.dispatch_retries, DISPATCH_BACKOFF_SECONDS.length);
      assertEquals(item.lease_owner, null);
      assertEquals(item.next_dispatch_at, null);

      // 统一终结：尝试进入 platform_error 终态，源活动指针清空、运行状态 error
      const [attempt] = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, attemptId as string),
      );
      assertEquals(attempt.state, "error");
      assertEquals(attempt.result_kind, "platform_error");
      const [source] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(source.active_attempt_id, null);
      assertEquals(source.status, "error");
      // 未产生新的重测尝试
      const attempts = await db.select({
        id: evaluationAttempts.id,
        source: evaluationAttempts.source,
      }).from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, submissionId),
      );
      assertEquals(
        attempts.filter((row) => row.source === "rejudge").length,
        1,
      );
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
    }
  },
});

Deno.test({
  name: "worker#37[真实 PG]: 双 worker 并发领取同批条目互不重复（SKIP LOCKED）",
  ignore: !hasRealPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 隔离 schema 可能残留其他用例/历史运行的可领取条目：先清空（领取即占用），
    // 让并发领取断言只针对本用例创建的 2 条条目（避免 SKIP LOCKED 命中遗留行）。
    for (let i = 0; i < 50; i++) {
      const drained = await claimJobItems("dual-drain", { limit: 100 });
      if (drained.length === 0) break;
    }
    const actor = await makeUser("dual");
    const { problemId, v1 } = await seedProblemWithVersions("dual");
    const first = await seedSubmission(problemId, actor, v1);
    const second = await seedSubmission(problemId, actor, v1);
    const accepted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [
            { kind: "submission", id: first.submissionId },
            { kind: "submission", id: second.submissionId },
          ],
        },
        target: { mode: "submitted" },
      },
      `conc-dual-key-${ts}`,
    );
    const jobId = accepted.job_id;
    createdFixtures.jobIds.add(jobId);

    // 两个 worker 并发领取：SKIP LOCKED 必须保证同一行不被两个 worker 同时占用。
    // （每 worker 只领 1 条：否则先到者会一口气领走全部，掩盖并发语义。）
    const [batchA, batchB] = await Promise.all([
      claimJobItems("dual-worker-A", { limit: 1 }),
      claimJobItems("dual-worker-B", { limit: 1 }),
    ]);
    const claimedIds = [...batchA, ...batchB].map((item) => item.id);
    assertEquals(new Set(claimedIds).size, claimedIds.length);
    const mine = [...batchA, ...batchB].filter((item) => item.job_id === jobId);
    assertEquals(mine.length >= 1, true);
    if (mine.length === 2) {
      // 两次并发领取都命中本任务（单独运行本文件时的预期路径）：各自持有不同条目
      assertEquals(mine[0].id !== mine[1].id, true);
    }
    const rows = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.job_id, jobId),
    );
    // 本用例领取到的条目：持有者必须是并发领取的两个 worker 之一，且每条唯一
    const mineIds = mine.map((item) => item.id);
    for (const row of rows) {
      if (row.status === "preparing" && mineIds.includes(row.id)) {
        assertEquals(
          ["dual-worker-A", "dual-worker-B"].includes(row.lease_owner ?? ""),
          true,
        );
      }
    }
    if (mine.length === 2) {
      // 两次并发领取都命中本任务：两条都必须被占用（不再 pending）
      assertEquals(
        rows.filter((row) => row.status === "pending").length,
        0,
      );
    }
  },
});

Deno.test({
  name: "jobs#39[真实 PG]: 并发聚合后任务终态不因过时统计回退为 running",
  ignore: !hasRealPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("status");
    const { problemId, v1 } = await seedProblemWithVersions("status");
    const { submissionId } = await seedSubmission(problemId, actor, v1);
    const accepted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "submitted" },
      },
      `conc-status-key-${ts}`,
    );
    const jobId = accepted.job_id;
    createdFixtures.jobIds.add(jobId);

    const itemId = (await loadItem(jobId)).id;

    // 并发：一半先写条目终态再聚合，另一半只聚合。
    // 若聚合读取与任务更新不在同一事务的同一行锁内，过时的「还有在途条目」
    // 统计可能在 completed 之后写回 running。
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (async () => {
          if (index % 2 === 0) {
            await completeJobItem(itemId, { status: "succeeded" });
          }
          await refreshJobStatus(jobId);
        })()),
    );

    const final = await refreshJobStatus(jobId);
    assertEquals(final, "completed");
    const [job] = await db.select().from(submissionJobs).where(
      eq(submissionJobs.id, jobId),
    );
    assertEquals(job.status, "completed");
  },
});

/**
 * 文件末尾统一清理（真实 PG 下本文件关闭了 preload 事务，必须显式删除夹具）。
 *
 * 依赖 Deno 在单文件内按声明顺序执行测试；清理用例声明在最后。
 */
Deno.test({
  name: "cleanup: 删除本文件在真实 PG 下创建的夹具",
  ignore: !hasRealPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    for (const jobId of createdFixtures.jobIds) {
      await db.delete(submissionJobItems).where(
        eq(submissionJobItems.job_id, jobId),
      );
      await db.delete(submissionJobs).where(eq(submissionJobs.id, jobId));
    }
    // 按题目删除**全部**提交（含派发生成的升级副本，它们不在登记集合里），
    // 否则其 `submitted_version_id` 外键会阻止删除版本行
    for (const problemId of createdFixtures.problemIds) {
      const subs = await db.select({ id: submissions.id }).from(submissions)
        .where(eq(submissions.problem_id, problemId));
      for (const row of subs) {
        await db.delete(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, row.id),
        );
      }
      await db.delete(submissions).where(
        eq(submissions.problem_id, problemId),
      );
    }
    for (const submissionId of createdFixtures.submissionIds) {
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, submissionId),
      );
      await db.delete(submissions).where(eq(submissions.id, submissionId));
    }
    for (const problemId of createdFixtures.problemIds) {
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await db.delete(problems).where(eq(problems.id, problemId));
    }
    // 账号由独立测试 schema 的生命周期管理，保留已加入 main 的身份与历史外键。
  },
});
