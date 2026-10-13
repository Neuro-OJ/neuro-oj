import { resetDbForTest } from "../../../../shared/db/connection.ts";
/**
 * 批任务受理的缺陷回归（tracking #31、#32、#40、#41）。
 *
 * 覆盖：
 * - #31 策略变更与任务受理**同一事务**：第二项策略失败时第一项策略与任务全部回滚；
 * - #32 策略变更作用域必须同时校验**竞赛维度**（任务范围外的竞赛 → 任何写入前拒绝）；
 * - #40 重试任务的幂等身份包含父任务类型/ID + 规范化条目 + 固定目标映射；
 *   不同父任务同键 → 409；升级任务不能被解释成重测；并发唯一冲突重读已提交任务；
 * - #41 大任务分批插入：受理路径按批落库、重试路径同样分批，
 *   成员集合仍在受理事务内固定。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  judgeImages,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  acceptRejudgeJob,
  JOB_ITEM_INSERT_BATCH,
  refreshJobStatus,
  type RejudgeRequest,
  retryRejudgeJob,
} from "../../services/versioning/rejudge-jobs.ts";
import { insertContestProblems } from "../../../../../tests/helper.ts";
import { bindMainProblemForTest } from "../_versioning-fixtures.ts";

await resetDbForTest();

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

await getDb().insert(users).values({
  id: "ja-admin",
  username: "ja-admin",
  email: "ja-admin@test.noj",
  password_hash: "hash",
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();

/** 建题 + 两个已发布版本（v1 / v2，latest = v2）。 */
async function seedProblem(problemId: string, number: number): Promise<void> {
  const db = getDb();
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: problemId,
    description: "d",
    number,
    owner_id: "0",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  for (const version of [1, 2]) {
    await db.insert(problemVersions).values({
      id: `${problemId}-v${version}`,
      problem_id: problemId,
      version,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    });
  }
  await db.update(problems).set({ latest_version_id: `${problemId}-v2` }).where(
    eq(problems.id, problemId),
  );
  await bindMainProblemForTest(problemId, "ja-admin");
}

async function seedSubmission(
  id: string,
  problemId: string,
  contestId: string | null = null,
): Promise<void> {
  await getDb().insert(submissions).values({
    id,
    user_id: "ja-admin",
    problem_id: problemId,
    contest_id: contestId,
    language: "python",
    code: "x",
    submitted_version_id: `${problemId}-v1`,
    version_origin: "known",
    created_at: now,
  });
}

async function seedContest(contestId: string, publicId: string): Promise<void> {
  await getDb().insert(contests).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: contestId,
    public_id: publicId,
    title: contestId,
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
}

function request(overrides: Partial<RejudgeRequest> = {}): RejudgeRequest {
  return {
    kind: "rejudge",
    scope: { type: "selected", submissions: [] },
    target: { mode: "submitted" },
    ...overrides,
  };
}

Deno.test("jobs#31: 第二项策略失败时第一项策略与任务全部回滚", async () => {
  const db = getDb();
  await seedProblem("ja-p1", 996001);
  await seedProblem("ja-p2", 996002);
  await seedSubmission("ja-s1", "ja-p1");
  await seedSubmission("ja-s2", "ja-p2");
  // ja-p2 的 revision 已被其他管理员推进到 3
  await db.update(domainProblemBindings).set({ revision: 3 }).where(
    eq(domainProblemBindings.problem_id, "ja-p2"),
  );

  await assertRejects(
    () =>
      acceptRejudgeJob(
        "ja-admin",
        request({
          scope: {
            type: "selected",
            submissions: [
              { kind: "submission", id: "ja-s1" },
              { kind: "submission", id: "ja-s2" },
            ],
          },
          policy_changes: [
            // 第一项合法：按题号排序会先执行
            {
              problem_id: "ja-p1",
              expected_revision: 0,
              policy: { mode: "exact", version_id: "ja-p1-v2" },
            },
            // 第二项 revision 过时 → 整次受理失败
            {
              problem_id: "ja-p2",
              expected_revision: 0,
              policy: { mode: "any" },
            },
          ],
        }),
        "ja-key-atomic",
      ),
    Error,
    "题库配置已变化",
  );

  // 第一项策略必须一起回滚（不是"先提交策略再建任务"）
  const [p1] = await db.select().from(problems).where(eq(problems.id, "ja-p1"));
  assertEquals(p1.effective_version_mode, "any");
  assertEquals(p1.required_version_id, null);
  assertEquals(p1.effective_policy_revision, 0);
  const [p2] = await db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, "ja-p2"),
  );
  assertEquals(p2.revision, 3);
  const [binding1] = await db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, "ja-p1"),
  );
  assertEquals(binding1.revision, 0);
  assertEquals(binding1.effective_version_mode, "any");
  // 未产生任务与条目
  assertEquals(
    (await db.select().from(submissionJobs).where(
      eq(submissionJobs.idempotency_key, "ja-key-atomic"),
    )).length,
    0,
  );
  assertEquals(
    (await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.problem_id, "ja-p1"),
    )).length,
    0,
  );
});

Deno.test("jobs#32: 策略变更作用域校验竞赛维度", async () => {
  const db = getDb();
  await seedProblem("ja-p3", 996003);
  await seedContest("ja-c1", "ct-ja1");
  await seedContest("ja-c2", "ct-ja2");
  await insertContestProblems({
    contest_id: "ja-c1",
    problem_id: "ja-p3",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: "ja-p3-v1",
  });
  await insertContestProblems({
    contest_id: "ja-c2",
    problem_id: "ja-p3",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: "ja-p3-v1",
  });
  await seedSubmission("ja-s-c1", "ja-p3", "ja-c1");
  await seedSubmission("ja-s-c2", "ja-p3", "ja-c2");

  // 任务只含 ja-c1 的提交：改 ja-c2 同题的策略必须被拒绝，且在任何写入前
  await assertRejects(
    () =>
      acceptRejudgeJob(
        "ja-admin",
        request({
          scope: {
            type: "selected",
            submissions: [{ kind: "submission", id: "ja-s-c1" }],
          },
          policy_changes: [{
            problem_id: "ja-p3",
            contest_id: "ja-c2",
            expected_revision: 0,
            policy: { mode: "any" },
          }],
        }),
        "ja-key-scope-1",
      ),
    Error,
    "任务范围之外的竞赛",
  );
  const [c2] = await db.select().from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, "ja-c2"),
      eq(contestProblems.problem_id, "ja-p3"),
    ),
  );
  assertEquals(c2.effective_policy_revision, 0);
  assertEquals(c2.pinned_version_id, "ja-p3-v1");

  // 作用域内的竞赛 × 题目 → 生效
  const accepted = await acceptRejudgeJob(
    "ja-admin",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "ja-s-c1" }],
      },
      policy_changes: [{
        problem_id: "ja-p3",
        contest_id: "ja-c1",
        expected_revision: 0,
        policy: { mode: "exact", version_id: "ja-p3-v2" },
      }],
    }),
    "ja-key-scope-2",
  );
  assertEquals(accepted.total_items, 1);
  const [c1] = await db.select().from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, "ja-c1"),
      eq(contestProblems.problem_id, "ja-p3"),
    ),
  );
  assertEquals(c1.effective_version_mode, "exact");
  assertEquals(c1.required_version_id, "ja-p3-v2");
  // exact(X) 同时固定作答版本为 X
  assertEquals(c1.pinned_version_id, "ja-p3-v2");
  assertEquals(c1.effective_policy_revision, 1);
});

Deno.test("jobs#40: 重试幂等身份含父任务与条目，父任务 kind 必须为 rejudge", async () => {
  const db = getDb();
  await seedProblem("ja-p4", 996004);
  await seedSubmission("ja-s4a", "ja-p4");
  await seedSubmission("ja-s4b", "ja-p4");

  // 幂等键形态校验
  await assertRejects(
    () => retryRejudgeJob("ja-admin", "missing-job", ""),
    Error,
    "必须提供 Idempotency-Key",
  );
  await assertRejects(
    () => retryRejudgeJob("ja-admin", "missing-job", "x".repeat(129)),
    Error,
    "必须提供 Idempotency-Key",
  );
  await assertRejects(
    () => retryRejudgeJob("ja-admin", "missing-job", "ja-retry-missing"),
    Error,
    "任务不存在",
  );

  // 升级任务不能被解释成重测
  await db.insert(submissionJobs).values({
    id: "ja-upgrade-job",
    kind: "upgrade",
    actor_id: "ja-admin",
    idempotency_key: "ja-upgrade-key",
    request_hash: "h",
    request: {},
    status: "completed",
    created_at: now,
  });
  await assertRejects(
    () => retryRejudgeJob("ja-admin", "ja-upgrade-job", "ja-retry-upgrade"),
    Error,
    "仅能重试重测任务",
  );

  // 两个父任务，各自的条目全部 failed
  const parentA = await acceptRejudgeJob(
    "ja-admin",
    request({
      scope: {
        type: "selected",
        submissions: [
          { kind: "submission", id: "ja-s4a" },
          { kind: "submission", id: "ja-s4b" },
        ],
      },
    }),
    "ja-key-parent-a",
  );
  const parentB = await acceptRejudgeJob(
    "ja-admin",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "ja-s4a" }],
      },
    }),
    "ja-key-parent-b",
  );
  for (const jobId of [parentA.job_id, parentB.job_id]) {
    await db.update(submissionJobItems).set({
      status: "failed",
      finished_at: now,
    })
      .where(eq(submissionJobItems.job_id, jobId));
  }

  const retried = await retryRejudgeJob(
    "ja-admin",
    parentA.job_id,
    "ja-key-retry-1",
  );
  assertEquals(retried.total_items, 2);
  assertEquals(retried.existing, false);

  // 同键同请求 → 复用原任务（不新建）
  const repeat = await retryRejudgeJob(
    "ja-admin",
    parentA.job_id,
    "ja-key-retry-1",
  );
  assertEquals(repeat.existing, true);
  assertEquals(repeat.job_id, retried.job_id);

  // 不同父任务复用同一幂等键 → 409（哈希含父任务 ID）
  await assertRejects(
    () => retryRejudgeJob("ja-admin", parentB.job_id, "ja-key-retry-1"),
    Error,
    "已用于不同的请求",
  );

  // 条目集合变化后同键重放仍返回原任务（幂等语义），不会新建第二个重试任务
  await db.update(submissionJobItems).set({ status: "failed" }).where(
    and(
      eq(submissionJobItems.job_id, retried.job_id),
      eq(submissionJobItems.source_id, "ja-s4a"),
    ),
  );
  const replay = await retryRejudgeJob(
    "ja-admin",
    parentA.job_id,
    "ja-key-retry-1",
  );
  assertEquals(replay.existing, true);
  assertEquals(replay.job_id, retried.job_id);
});

Deno.test("jobs#41: 受理与重试路径分批插入条目（超出单条 INSERT 参数上限）", async () => {
  const db = getDb();
  await seedProblem("ja-p5", 996005);
  // 受理路径：题目范围含 250 条提交 → 3 个批次
  const total = JOB_ITEM_INSERT_BATCH * 2 + 50;
  const rows: Array<typeof submissions.$inferInsert> = [];
  for (let index = 0; index < total; index++) {
    rows.push({
      id: `ja-bulk-${index}`,
      user_id: "ja-admin",
      problem_id: "ja-p5",
      language: "python",
      code: "x",
      submitted_version_id: "ja-p5-v1",
      version_origin: "known",
      created_at: now,
    });
  }
  for (let offset = 0; offset < rows.length; offset += 200) {
    await db.insert(submissions).values(rows.slice(offset, offset + 200));
  }

  const accepted = await acceptRejudgeJob(
    "ja-admin",
    request({ scope: { type: "problem", problem_id: "ja-p5" } }),
    "ja-key-bulk",
  );
  assertEquals(accepted.total_items, total);
  const ordinals = await db.select({ ordinal: submissionJobItems.ordinal })
    .from(submissionJobItems).where(
      eq(submissionJobItems.job_id, accepted.job_id),
    ).orderBy(submissionJobItems.ordinal);
  assertEquals(ordinals.length, total);
  assertEquals(ordinals[0].ordinal, 0);
  assertEquals(ordinals[total - 1].ordinal, total - 1);
  assertEquals(
    new Set(ordinals.map((row) => row.ordinal)).size,
    total,
  );

  // 重试路径：全部 failed → 重试任务同样按批插入
  await db.update(submissionJobItems).set({
    status: "failed",
    finished_at: now,
  })
    .where(eq(submissionJobItems.job_id, accepted.job_id));
  const retried = await retryRejudgeJob(
    "ja-admin",
    accepted.job_id,
    "ja-key-bulk-retry",
  );
  assertEquals(retried.total_items, total);
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(submissionJobItems).where(
      eq(submissionJobItems.job_id, retried.job_id),
    );
  assertEquals(countRow.count, total);
});

Deno.test("jobs#41: insertJobItemsBatched 按批次拆分单语句（真实 PG 参数上限）", async () => {
  // 真实 PostgreSQL 单语句最多 65535 个绑定参数；每条目 13 列 → 约 5041 行封顶。
  // 这里用记录型 executor 直接断言拆分行为（PGlite 不强制该上限，故不能靠行数证明）。
  const { insertJobItemsBatched } = await import(
    "../../services/versioning/rejudge-jobs.ts"
  );
  const batchSizes: number[] = [];
  const stub = {
    insert: () => ({
      values: (rows: unknown[]) => {
        batchSizes.push(rows.length);
        return Promise.resolve();
      },
    }),
  } as unknown as Parameters<typeof insertJobItemsBatched>[0];
  const rows = Array.from(
    { length: JOB_ITEM_INSERT_BATCH * 2 + 7 },
    (_, index) => ({ id: `x-${index}`, job_id: "j", ordinal: index }) as never,
  );
  await insertJobItemsBatched(stub, rows);
  assertEquals(batchSizes, [JOB_ITEM_INSERT_BATCH, JOB_ITEM_INSERT_BATCH, 7]);
  // 批次大小 × 13 列必须低于 PostgreSQL 参数上限
  assertEquals(JOB_ITEM_INSERT_BATCH * 13 < 65535, true);
});

Deno.test("jobs#41: 大批量条目真实落库（5200 行按批插入）", async () => {
  const db = getDb();
  await db.insert(submissionJobs).values({
    id: "ja-batch-job",
    kind: "rejudge",
    actor_id: "ja-admin",
    idempotency_key: "ja-batch-key",
    request_hash: "h",
    request: {},
    status: "queued",
    created_at: now,
  });
  const { insertJobItemsBatched } = await import(
    "../../services/versioning/rejudge-jobs.ts"
  );

  const rows: Array<typeof submissionJobItems.$inferInsert> = [];
  for (let index = 0; index < 5200; index++) {
    rows.push({
      id: `ja-batch-item-${index}`,
      job_id: "ja-batch-job",
      ordinal: index,
      source_kind: "submission",
      source_id: `ja-batch-src-${index}`,
      problem_id: "ja-p6",
      target_version_id: null,
      target_version_ref: null,
      status: "pending",
      created_at: now,
    });
  }
  await insertJobItemsBatched(db, rows);
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(submissionJobItems).where(
      eq(submissionJobItems.job_id, "ja-batch-job"),
    );
  assertEquals(countRow.count, rows.length);
});

Deno.test("jobs#39: 任务聚合写入与条目统计同事务（completed 不回退 running）", async () => {
  const db = getDb();
  await seedProblem("ja-p7", 996007);
  await seedSubmission("ja-s7", "ja-p7");
  const accepted = await acceptRejudgeJob(
    "ja-admin",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "ja-s7" }],
      },
    }),
    "ja-key-status",
  );

  // 全部条目终态后 repeated refresh 必须稳定为 completed
  await db.update(submissionJobItems).set({
    status: "succeeded",
    finished_at: now,
  })
    .where(eq(submissionJobItems.job_id, accepted.job_id));
  assertEquals(await refreshJobStatus(accepted.job_id), "completed");
  assertEquals(await refreshJobStatus(accepted.job_id), "completed");
  assertEquals(await refreshJobStatus(accepted.job_id), "completed");
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, accepted.job_id),
  );
  assertEquals(job.status, "completed");
  assertEquals(typeof job.finished_at, "string");

  // 有 failed 条目时终态是 completed_with_errors，同样不因重复聚合回退
  await db.update(submissionJobItems).set({ status: "failed" }).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  );
  assertEquals(
    await refreshJobStatus(accepted.job_id),
    "completed_with_errors",
  );
  assertEquals(
    await refreshJobStatus(accepted.job_id),
    "completed_with_errors",
  );
});
