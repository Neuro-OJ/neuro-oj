import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { contestProblemExecutionForTest } from "../../../../../tests/helper.ts";
import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
/**
 * 锁内复查分类的**真实 PostgreSQL 屏障**回归（复审问题 10，P2）。
 *
 * 场景：派发流程在"读取源 → 预检"之后、**创建尝试前的行锁内复查**之前，源被并发
 * 改变（活动尝试被换成另一个 / 整行被删除）。此时不得把条目记为 `failed`——Handbook
 * 固定分类要求 `SOURCE_JUDGING` / `SOURCE_DELETED` → 条目 **`skipped`**（可重试）。
 *
 * 实现方式：用原生连接在**同一真实事务**内先 `SELECT ... FOR UPDATE` 锁住源提交行，
 * 再启动派发；派发通过预检后阻塞在行锁上，此时在持锁事务内改写/删除源并提交，
 * 让锁内复查稳定地观察到变化（无 sleep 竞态假设——提交顺序由行锁决定）。
 *
 * 隔离：屏障需要两条真实连接，因此显式使用唯一 ID 并在用例结束时清理；由测试
 * 启动器提供独立数据库并串行执行。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray, sql } from "drizzle-orm";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  domains,
  educationOutbox,
  evaluationAttempts,
  judgeImages,
  objectiveSubmissions,
  problemBindingHistory,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import {
  dispatchJobItem,
  type DispatchOutcome,
} from "../../services/versioning/dispatch-job-item.ts";
import {
  acceptLegacyRejudgeJobForTest as acceptRejudgeJob,
  authorizeLegacyJobActorForTest,
  bindMainProblemForTest,
} from "../_versioning-fixtures.ts";
import { acceptUpgradeJob } from "../../services/versioning/upgrade-jobs.ts";
import {
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
} from "../../services/versioning/effective-policy.ts";
import { withRawTransaction } from "../../../../../tests/helper/pg-raw-connection.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";

/** 双连接屏障使用真实 PostgreSQL。 */

// 屏障依赖"原生连接能看到已提交夹具"，因此本文件不再包逐用例事务。
const db = getDb();
const ts = Date.now();
const now = new Date().toISOString();

/**
 * 屏障夹具使用稳定题号，避免随机号在同一 Domain 测试库内碰撞。
 * 题号只服务于夹具，不应与产品默认题库的低位编号混用。
 */
function fixtureProblemNumber(kind: "standard" | "objective", tag: string) {
  let hash = kind === "objective" ? 17 : 0;
  for (const char of tag) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return 6_000_000 + (hash % 100_000);
}

const dualConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 1111,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

/** 评测镜像白名单：真实 PG schema 由迁移创建，不含种子数据。 */
async function ensureJudgeImages(): Promise<void> {
  await db.insert(judgeImages).values([
    {
      id: "e0000000-0000-0000-0000-000000000002",
      image: "noj-evaluator-python",
      mode: "all_versions",
      kind: "evaluator",
      description: "屏障测试",
      created_at: now,
      updated_at: now,
    },
    {
      id: "e0000000-0000-0000-0000-000000000003",
      image: "noj-solution-python",
      mode: "all_versions",
      kind: "solution",
      description: "屏障测试",
      created_at: now,
      updated_at: now,
    },
  ]).onConflictDoNothing();
}

interface Fixture {
  userId: string;
  problemId: string;
  versionId: string;
  submissionId: string;
  jobId: string;
  itemId: string;
  owner: string;
}

/** 建夹具（真实 PG 下直接提交，供原生连接可见）。 */
async function seedFixture(tag: string): Promise<Fixture> {
  const userId = `skp-user-${tag}-${ts}`;
  const problemId = `skp-prob-${tag}-${ts}`;
  const versionId = `skp-v1-${tag}-${ts}`;
  const submissionId = crypto.randomUUID();
  const owner = `skp-w-${tag}`;
  await ensureJudgeImages();
  await db.insert(users).values({
    id: userId,
    username: `skp-${tag}-${ts}`,
    email: `skp-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await authorizeLegacyJobActorForTest(userId);
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: `屏障测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: fixtureProblemNumber("standard", tag),
    // 测试库由迁移创建，不含 root 种子，因此用夹具用户做题主
    owner_id: userId,
    judge_type: "dual",
    runtime_config: dualConfig,
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
      title: `屏障测试题 ${tag}`,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: dualConfig,
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  await bindPublishedProblemForTest(problemId);
  await db.insert(submissions).values({
    ...(await problemExecutionForTest(problemId)),
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
  const accepted = await acceptRejudgeJob(
    userId,
    {
      kind: "rejudge",
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: submissionId }],
      },
      target: { mode: "submitted" },
    },
    `skp-key-${tag}-${ts}`,
  );
  const [item] = (await claimJobItems(owner, { limit: 100 })).filter(
    (row) => row.job_id === accepted.job_id,
  );
  return {
    userId,
    problemId,
    versionId,
    submissionId,
    jobId: accepted.job_id,
    itemId: item.id,
    owner,
  };
}

/** 清理夹具（含被中途删除/改写的行）。 */
async function cleanup(fixture: Fixture): Promise<void> {
  await db.delete(submissionJobItems).where(
    eq(submissionJobItems.job_id, fixture.jobId),
  );
  await db.delete(submissionJobs).where(eq(submissionJobs.id, fixture.jobId));
  await db.delete(evaluationAttempts).where(
    inArray(evaluationAttempts.problem_id, [fixture.problemId]),
  );
  await db.delete(submissions).where(
    eq(submissions.id, fixture.submissionId),
  );
  // 先摘掉最新版指针（problems_latest_version_fk），再删版本行
  await db.update(problems).set({ latest_version_id: null }).where(
    eq(problems.id, fixture.problemId),
  );
  const bindings = await db.select({ id: domainProblemBindings.id }).from(
    domainProblemBindings,
  ).where(eq(domainProblemBindings.problem_id, fixture.problemId));
  for (const binding of bindings) {
    await db.delete(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, binding.id),
    );
  }
  await db.delete(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, fixture.problemId),
  );
  await db.delete(problemVersions).where(
    inArray(problemVersions.problem_id, [fixture.problemId]),
  );
  await deleteProblemFixtures(eq(problems.id, fixture.problemId));
  // 域身份是保留历史，不物理删除账号；由独立测试 schema 的生命周期管理。
}

/**
 * 在持锁事务内启动派发、改写源、提交，然后等待派发结论。
 *
 * @param mutate 在持有源行锁的同一事务内执行的改写（换活动尝试 / 删除整行）
 */
async function dispatchWithConcurrentSourceChange(
  fixture: Fixture,
  mutate: (
    tx: Parameters<Parameters<typeof withRawTransaction>[0]>[0],
  ) => Promise<void>,
): Promise<DispatchOutcome> {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, fixture.itemId),
  );
  let pending: Promise<DispatchOutcome> | null = null;
  await withRawTransaction(async (tx) => {
    // 1) 先锁住源提交行：派发的行内复查会阻塞在此
    await tx.select({ id: submissions.id }).from(submissions).where(
      eq(submissions.id, fixture.submissionId),
    ).for("update");
    // 2) 启动派发（它会读完源、通过预检，然后阻塞在行锁上）
    pending = dispatchJobItem(item, fixture.owner, "rejudge");
    // 3) 让派发到达行锁（提交顺序由行锁决定，不依赖具体延时长短）
    await new Promise((resolve) => setTimeout(resolve, 400));
    await mutate(tx);
    // 4) 回调返回即提交：派发的锁内复查随后观察到新状态
  });
  assertEquals(pending !== null, true);
  return await pending!;
}

Deno.test({
  name: "skipped#10[真实 PG]: 预检期间源被换上别的活动尝试 → 锁内 skipped",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedFixture("judging");
    try {
      const concurrentAttemptId = crypto.randomUUID();
      const outcome = await dispatchWithConcurrentSourceChange(
        fixture,
        async (tx) => {
          // 先插入一条真实尝试（submissions.active_attempt_id 有外键），
          // 再把它设为源的活动尝试：等价于"另一个任务抢先创建了尝试"
          await tx.insert(evaluationAttempts).values({
            id: concurrentAttemptId,
            submission_id: fixture.submissionId,
            problem_id: fixture.problemId,
            problem_version_id: fixture.versionId,
            sequence: 9,
            source: "rejudge",
            state: "queued",
            created_at: now,
          });
          await tx.update(submissions).set({
            active_attempt_id: concurrentAttemptId,
            status: "pending",
          }).where(eq(submissions.id, fixture.submissionId));
        },
      );
      assertEquals(outcome, "skipped");
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "skipped");
      assertEquals(item.reason_code, "SOURCE_JUDGING");
      assertEquals(item.attempt_id, null);
      // 本条目未创建尝试：源上只有并发写者插入的那一条（锁内复查在创建之前）
      const attempts = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, fixture.submissionId),
      );
      assertEquals(attempts.length, 1);
      assertEquals(attempts[0].id, concurrentAttemptId);
    } finally {
      await cleanup(fixture);
    }
  },
});

Deno.test({
  name: "skipped#10[真实 PG]: 预检期间源被删除 → 锁内 skipped + SOURCE_DELETED",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedFixture("deleted");
    try {
      const outcome = await dispatchWithConcurrentSourceChange(
        fixture,
        async (tx) => {
          await tx.delete(submissions).where(
            eq(submissions.id, fixture.submissionId),
          );
        },
      );
      assertEquals(outcome, "skipped");
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "skipped");
      assertEquals(item.reason_code, "SOURCE_DELETED");
      assertEquals(item.attempt_id, null);
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, fixture.submissionId),
        )).length,
        0,
      );
    } finally {
      await cleanup(fixture);
    }
  },
});

Deno.test({
  name:
    "sequence#1[真实 PG]: 预检期间另一轮评测完成 → 任务封套仍取落库 sequence",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedFixture("seq");
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      // 存量提交带着较大的源序号（无尝试行时不回退）
      await db.update(submissions).set({ rejudge_seq: 3 }).where(
        eq(submissions.id, fixture.submissionId),
      );

      const concurrentAttemptId = crypto.randomUUID();
      const outcome = await dispatchWithConcurrentSourceChange(
        fixture,
        async (tx) => {
          // 派发阻塞在源行锁期间，"另一轮评测"完成：插入 sequence=5 的尝试并推进源序号
          await tx.insert(evaluationAttempts).values({
            id: concurrentAttemptId,
            submission_id: fixture.submissionId,
            problem_id: fixture.problemId,
            problem_version_id: fixture.versionId,
            sequence: 5,
            source: "rejudge",
            state: "finished",
            created_at: now,
          });
          await tx.update(submissions).set({ rejudge_seq: 5 }).where(
            eq(submissions.id, fixture.submissionId),
          );
        },
      );
      assertEquals(outcome, "dispatched");

      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      const [attempt] = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, item.attempt_id as string),
      );
      // 锁内统一分配：max(MAX(尝试)+1 = 6, 源序号 5) = 6
      assertEquals(attempt.sequence, 6);
      // 任务封套必须与落库一致（复审问题 1：不一致会让结果被静默丢弃）
      const messages: Record<string, unknown>[] = [];
      for (
        const queue of [
          "noj:judge:queue:ai:low",
          "noj:judge:queue:ai:medium",
        ]
      ) {
        for (const raw of fake.getMessages(queue)) {
          messages.push(JSON.parse(raw) as Record<string, unknown>);
        }
      }
      assertEquals(messages.length, 1);
      assertEquals(messages[0].rejudge_seq, 6);
      assertEquals(messages[0].run_id, attempt.id);
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
      await cleanup(fixture);
    }
  },
});

/** 客观题夹具：题目 + 客观题版本 + 客观题提交 + 任务条目。 */
interface ObjectiveFixture extends Fixture {
  objectiveSubmissionId: string;
  contestId: string | null;
}

async function seedObjectiveFixture(
  tag: string,
  jobKind: "rejudge" | "upgrade",
  inContest = false,
): Promise<ObjectiveFixture> {
  const userId = `skp-obj-user-${tag}-${ts}`;
  const problemId = `skp-obj-prob-${tag}-${ts}`;
  const versionId = `skp-obj-v1-${tag}-${ts}`;
  const latestVersionId = `skp-obj-v2-${tag}-${ts}`;
  const objectiveSubmissionId = crypto.randomUUID();
  const contestId = inContest ? `skp-obj-contest-${tag}-${ts}` : null;
  const owner = `skp-obj-w-${tag}`;
  await ensureJudgeImages();
  await db.insert(users).values({
    id: userId,
    username: `skp-obj-${tag}-${ts}`,
    email: `skp-obj-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await authorizeLegacyJobActorForTest(userId);
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: `客观题屏障测试 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: fixtureProblemNumber("objective", tag),
    owner_id: userId,
    judge_type: "dual",
    is_objective: true,
    runtime_config: dualConfig,
    created_at: now,
    updated_at: now,
  });
  const objectiveContent = (title: string) => ({
    kind: "objective",
    title,
    description: "d",
    samples: [],
    questions: [],
  });
  await db.insert(problemVersions).values([
    {
      id: versionId,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: objectiveContent(`客观题屏障测试 ${tag} V1`),
      published_at: now,
    },
    {
      // 升级目标是"受理时固定的最新版"：必须与源版本不同（否则 ALREADY_LATEST）
      id: latestVersionId,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: objectiveContent(`客观题屏障测试 ${tag} V2`),
      published_at: now,
    },
  ]);
  await db.update(problems).set({ latest_version_id: latestVersionId }).where(
    eq(problems.id, problemId),
  );
  await bindPublishedProblemForTest(problemId);
  if (contestId) {
    await db.insert(contests).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: contestId,
      title: `客观题策略锁序 ${tag}`,
      description: "",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 60_000).toISOString(),
      type: "kaggle",
      kind: "public",
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      ...await contestProblemExecutionForTest(contestId, problemId),
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      score: 100,
      pinned_version_id: versionId,
    });
  }
  await db.insert(objectiveSubmissions).values({
    ...(await problemExecutionForTest(problemId)),
    id: objectiveSubmissionId,
    paper_id: problemId,
    user_id: userId,
    contest_id: contestId,
    submission_type: contestId ? "contest" : "practice",
    answers: {},
    status: "finished",
    score: 0,
    details: {},
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
  });
  const accepted = jobKind === "upgrade"
    ? await acceptUpgradeJob(
      userId,
      {
        submissions: [{ kind: "objective", id: objectiveSubmissionId }],
        context: "practice",
      },
      `skp-obj-key-${tag}-${ts}`,
    )
    : await acceptRejudgeJob(
      userId,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "objective", id: objectiveSubmissionId }],
        },
        target: { mode: "submitted" },
      },
      `skp-obj-key-${tag}-${ts}`,
    );
  const [item] = (await claimJobItems(owner, { limit: 100 })).filter(
    (row) => row.job_id === accepted.job_id,
  );
  return {
    userId,
    problemId,
    versionId,
    submissionId: objectiveSubmissionId,
    objectiveSubmissionId,
    jobId: accepted.job_id,
    itemId: item.id,
    owner,
    contestId,
  };
}

async function cleanupObjective(fixture: ObjectiveFixture): Promise<void> {
  await db.delete(educationOutbox).where(
    eq(educationOutbox.problem_id, fixture.problemId),
  );
  await db.delete(submissionJobItems).where(
    eq(submissionJobItems.job_id, fixture.jobId),
  );
  await db.delete(submissionJobs).where(eq(submissionJobs.id, fixture.jobId));
  const attempts = await db.select({ id: evaluationAttempts.id }).from(
    evaluationAttempts,
  ).where(eq(evaluationAttempts.problem_id, fixture.problemId));
  if (attempts.length > 0) {
    await db.delete(evaluationAttempts).where(
      inArray(
        evaluationAttempts.id,
        attempts.map((row) => row.id),
      ),
    );
  }
  await db.delete(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, fixture.objectiveSubmissionId),
  );
  if (fixture.contestId) {
    await db.delete(contests).where(eq(contests.id, fixture.contestId));
  }
  await db.update(problems).set({ latest_version_id: null }).where(
    eq(problems.id, fixture.problemId),
  );
  const bindings = await db.select({ id: domainProblemBindings.id }).from(
    domainProblemBindings,
  )
    .where(eq(domainProblemBindings.problem_id, fixture.problemId));
  for (const binding of bindings) {
    await db.delete(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, binding.id),
    );
  }
  await db.delete(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, fixture.problemId),
  );
  await db.delete(problemVersions).where(
    eq(problemVersions.id, fixture.versionId),
  );
  await deleteProblemFixtures(eq(problems.id, fixture.problemId));
  // 保留已加入 main 的账号身份，不能通过删除用户破坏域成员历史。
}

/**
 * 客观题屏障：持 `objective_submissions` 源行锁 → 启动派发 → 锁内改写源 → 提交。
 */
async function dispatchObjectiveWithChange(
  fixture: ObjectiveFixture,
  jobKind: "rejudge" | "upgrade",
  mutate: (
    tx: Parameters<Parameters<typeof withRawTransaction>[0]>[0],
  ) => Promise<void>,
): Promise<DispatchOutcome> {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, fixture.itemId),
  );
  let pending: Promise<DispatchOutcome> | null = null;
  await withRawTransaction(async (tx) => {
    await tx.select({ id: objectiveSubmissions.id }).from(objectiveSubmissions)
      .where(
        eq(objectiveSubmissions.id, fixture.objectiveSubmissionId),
      ).for("update");
    pending = dispatchJobItem(item, fixture.owner, jobKind, "practice");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await mutate(tx);
  });
  assertEquals(pending !== null, true);
  return await pending!;
}

/**
 * 确认派发已阻塞在指定宿主锁上，再让策略事务持宿主锁并重算源提交。
 * 若派发先锁了 objective_submissions，策略重算将与其形成真实锁环；修复后派发
 * 会先等宿主，策略更新可先拿源行并提交，随后派发继续。有限锁超时防止测试挂死。
 */
async function dispatchDuringObjectivePolicyChange(
  fixture: ObjectiveFixture,
  scope: "problem" | "contest",
): Promise<DispatchOutcome> {
  if (scope === "problem") await bindMainProblemForTest(fixture.problemId);
  if (scope === "contest" && !fixture.contestId) {
    throw new Error("竞赛策略用例缺少竞赛夹具");
  }
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, fixture.itemId),
  );
  const pendingDispatch: { promise?: Promise<DispatchOutcome> } = {};
  try {
    await withRawTransaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      const pidRows = unwrapRows<{ pid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as never,
      );
      const barrierPid = pidRows[0].pid;
      if (scope === "problem") {
        await tx.select({ id: domains.id }).from(domains).where(
          eq(domains.slug, "main"),
        ).for("update");
        await tx.select({ id: problems.id }).from(problems).where(
          eq(problems.id, fixture.problemId),
        ).for("update");
      } else {
        // 竞赛策略事务同样先持有域宿主，再按题目 → 竞赛顺序取锁；否则
        // 派发侧的 domain → problem → contest 会与策略侧 problem → contest
        // → domain 形成真实环。
        await tx.select({ id: domains.id }).from(domains).where(
          eq(domains.id, DEFAULT_DOMAIN_ID),
        ).for("share");
        await tx.select({ id: problems.id }).from(problems).where(
          eq(problems.id, fixture.problemId),
        ).for("share");
        await tx.select({ id: contests.id }).from(contests).where(
          eq(contests.id, fixture.contestId!),
        ).for("update");
      }

      pendingDispatch.promise = dispatchJobItem(item, fixture.owner, "rejudge");
      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        // UPDATE submission_job_items 也会因其 problem_id 外键先等待同一宿主行；
        // 因而不能只按 SQL 文本筛选 problems/contests。只要阻塞者就是本屏障
        // 事务，便能证明派发没有先拿 source 行锁而形成反向锁环。
        const waiting = unwrapRows<{ blocked: boolean }>(
          await tx.execute(sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity AS activity
              WHERE activity.pid <> ${barrierPid}
                AND activity.wait_event_type = 'Lock'
                AND ${barrierPid} = ANY(pg_blocking_pids(activity.pid))
            ) AS blocked
          `) as never,
        );
        if (waiting[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!blocked) throw new Error(`客观题派发未阻塞于 ${scope} 宿主锁`);

      if (scope === "problem") {
        await setProblemEffectiveVersionPolicy(fixture.problemId, {
          actorId: "0",
          policy: { mode: "any" },
          expectedRevision: 0,
        }, tx);
      } else {
        await setContestProblemEffectiveVersionPolicy(
          fixture.contestId!,
          fixture.problemId,
          {
            actorId: "0",
            policy: { mode: "any" },
            expectedRevision: 0,
          },
          tx,
        );
      }
      // 回调返回后先提交策略事务，释放宿主锁；派发继续在外层 await。
    });
  } finally {
    // 策略侧异常时释放宿主锁后也收束派发 Promise，避免留下挂起连接。
    if (pendingDispatch.promise) {
      await pendingDispatch.promise.catch(() => undefined);
    }
  }
  return await pendingDispatch.promise!;
}

Deno.test({
  name:
    "objective#8[真实 PG]: 客观题重判期间源被删除 → skipped + SOURCE_DELETED",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedObjectiveFixture("del", "rejudge");
    try {
      const outcome = await dispatchObjectiveWithChange(
        fixture,
        "rejudge",
        async (tx) => {
          await tx.delete(objectiveSubmissions).where(
            eq(objectiveSubmissions.id, fixture.objectiveSubmissionId),
          );
        },
      );
      assertEquals(outcome, "skipped");
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "skipped");
      assertEquals(item.reason_code, "SOURCE_DELETED");
      assertEquals(item.attempt_id, null);
      // 未创建任何新尝试（与普通提交分类一致，不再退化成 retry）
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.problem_id, fixture.problemId),
        )).length,
        0,
      );
    } finally {
      await cleanupObjective(fixture);
    }
  },
});

Deno.test({
  name:
    "objective#8[真实 PG]: 客观题重判期间源被换上活动尝试 → skipped + SOURCE_JUDGING",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedObjectiveFixture("judging", "rejudge");
    try {
      const concurrentAttemptId = crypto.randomUUID();
      const outcome = await dispatchObjectiveWithChange(
        fixture,
        "rejudge",
        async (tx) => {
          await tx.insert(evaluationAttempts).values({
            id: concurrentAttemptId,
            objective_submission_id: fixture.objectiveSubmissionId,
            problem_id: fixture.problemId,
            problem_version_id: fixture.versionId,
            sequence: 9,
            source: "rejudge",
            state: "queued",
            created_at: now,
          });
          await tx.update(objectiveSubmissions).set({
            active_attempt_id: concurrentAttemptId,
          }).where(
            eq(objectiveSubmissions.id, fixture.objectiveSubmissionId),
          );
        },
      );
      assertEquals(outcome, "skipped");
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "skipped");
      assertEquals(item.reason_code, "SOURCE_JUDGING");
      assertEquals(item.attempt_id, null);
    } finally {
      await cleanupObjective(fixture);
    }
  },
});

Deno.test({
  name: "objective#8[真实 PG]: 客观题升级期间源被删除 → skipped 且不留副本",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedObjectiveFixture("up-del", "upgrade");
    try {
      const outcome = await dispatchObjectiveWithChange(
        fixture,
        "upgrade",
        async (tx) => {
          await tx.delete(objectiveSubmissions).where(
            eq(objectiveSubmissions.id, fixture.objectiveSubmissionId),
          );
        },
      );
      assertEquals(outcome, "skipped");
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "skipped");
      assertEquals(item.reason_code, "SOURCE_DELETED");
      assertEquals(item.result_submission_id, null);
      // 事务回滚：没有留下任何升级副本
      assertEquals(
        (await db.select().from(objectiveSubmissions).where(
          eq(objectiveSubmissions.paper_id, fixture.problemId),
        )).length,
        0,
      );
    } finally {
      await cleanupObjective(fixture);
    }
  },
});

Deno.test({
  name: "objective lock order[真实 PG]: 题库策略修改与客观题重判按宿主先行串行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedObjectiveFixture("problem-policy", "rejudge");
    try {
      assertEquals(
        await dispatchDuringObjectivePolicyChange(fixture, "problem"),
        "dispatched",
      );
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "succeeded");
      assertEquals(typeof item.attempt_id, "string");
    } finally {
      await cleanupObjective(fixture);
    }
  },
});

Deno.test({
  name: "objective lock order[真实 PG]: 竞赛策略修改与客观题重判按宿主先行串行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await seedObjectiveFixture(
      "contest-policy",
      "rejudge",
      true,
    );
    try {
      assertEquals(
        await dispatchDuringObjectivePolicyChange(fixture, "contest"),
        "dispatched",
      );
      const [item] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, fixture.itemId),
      );
      assertEquals(item.status, "succeeded");
      assertEquals(typeof item.attempt_id, "string");
    } finally {
      await cleanupObjective(fixture);
    }
  },
});
