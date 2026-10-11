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
 * 隔离：本文件关闭 preload 的逐用例事务（屏障需要两条真实连接），因此显式使用
 * 唯一 ID 并在用例结束时清理；在**独立 schema**（TEST_SCHEMA）下由 Lead 串行执行。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
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
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import {
  dispatchJobItem,
  type DispatchOutcome,
} from "../../services/versioning/dispatch-job-item.ts";
import { acceptRejudgeJob } from "../../services/versioning/rejudge-jobs.ts";
import { withRawTransaction } from "../../../../../tests/helper/pg-raw-connection.ts";

/** 需要真实 PostgreSQL 的双连接屏障（PGlite 单连接无法并行）。 */
const hasRealPg = !!Deno.env.get("DATABASE_URL");

// 屏障依赖"原生连接能看到已提交夹具"，因此本文件不再包逐用例事务。
disableTestTransactionForFile();

const db = getDb();
const ts = Date.now();
const now = new Date().toISOString();

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
  await db.insert(problems).values({
    id: problemId,
    title: `屏障测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 94000 + Math.floor(Math.random() * 900),
    // 独立 schema 由迁移创建，不含 PGlite 的 root 种子 → 用夹具用户做题主
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
  await db.delete(problemVersions).where(
    eq(problemVersions.id, fixture.versionId),
  );
  await db.delete(problems).where(eq(problems.id, fixture.problemId));
  await db.delete(users).where(eq(users.id, fixture.userId));
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
  ignore: !hasRealPg,
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
  ignore: !hasRealPg,
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
