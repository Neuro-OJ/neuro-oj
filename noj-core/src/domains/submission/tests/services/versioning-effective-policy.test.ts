/**
 * 有效版本策略切换测试（Handbook §1.2、§4.5、§3.5）。
 *
 * 覆盖：any ⇄ exact 来回切换后投影**在同一事务提交后立即生效**、
 * 策略 revision 乐观锁、exact 版本必须属于该题且已发布、
 * 竞赛 exact(X) 同时固定作答版本、单独升级固定版本与现有 exact 冲突 → 409、
 * 竞赛与题库两个作用域互不影响、data_revision 递增。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  evaluationAttempts,
  problems,
  problemVersions,
  queryProjectionRevisions,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
  upgradeContestProblemPinnedVersion,
} from "../../services/versioning/effective-policy.ts";
import {
  problemScopeKey,
  type ProjectionSource,
  recomputeSubmissionProjection,
  upsertCurrentVersionResult,
} from "../../services/versioning/projection.ts";

const now = new Date().toISOString();

async function seedProblem(
  problemId: string,
  number: number,
): Promise<{ v1: string; v2: string }> {
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
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
  await db.update(problems).set({ latest_version_id: `${problemId}-v2` })
    .where(eq(problems.id, problemId));
  return { v1: `${problemId}-v1`, v2: `${problemId}-v2` };
}

async function seedSubmissionWithResult(input: {
  submissionId: string;
  problemId: string;
  versionId: string;
  score: number;
  accepted: boolean;
  contestId?: string | null;
}): Promise<ProjectionSource> {
  const db = getDb();
  await db.insert(submissions).values({
    id: input.submissionId,
    user_id: "0",
    problem_id: input.problemId,
    contest_id: input.contestId ?? null,
    language: "python",
    code: "x",
    submitted_version_id: input.versionId,
    version_origin: "known",
    created_at: now,
  });
  const source: ProjectionSource = {
    kind: "submission",
    id: input.submissionId,
    problem_id: input.problemId,
    contest_id: input.contestId ?? null,
  };
  const attemptId = `${input.submissionId}-a0`;
  await db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: input.submissionId,
    problem_id: input.problemId,
    problem_version_id: input.versionId,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    score: input.score,
    accepted: input.accepted,
    created_at: now,
  });
  await upsertCurrentVersionResult(db, {
    source,
    problemVersionId: input.versionId,
    attemptId,
  });
  await recomputeSubmissionProjection(db, source);
  return source;
}

async function seedContest(
  contestId: string,
  problemId: string,
  pinned: string,
) {
  const db = getDb();
  await db.insert(contests).values({
    id: contestId,
    public_id: `ct-${contestId}`.slice(0, 20),
    title: "c",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
  await db.insert(contestProblems).values({
    contest_id: contestId,
    problem_id: problemId,
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: pinned,
  });
}

Deno.test("policy: exact(V1) 提交后立即生效，切回 any 也立即生效", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("ep-p1", 992001);
  const source = await seedSubmissionWithResult({
    submissionId: "ep-s1",
    problemId: "ep-p1",
    versionId: v2,
    score: 10000,
    accepted: true,
  });
  // any 下通过
  let [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "ep-s1"),
  );
  assertEquals(submission.is_accepted, true);

  // 切到 exact(V1)：V2 的判定不再计入
  const changed = await setProblemEffectiveVersionPolicy("ep-p1", {
    policy: { mode: "exact", version_id: v1 },
    expectedRevision: 0,
  });
  assertEquals(changed.revision, 1);
  assertEquals(changed.affected_submissions, 1);
  [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "ep-s1"),
  );
  assertEquals(submission.is_valid, false);
  assertEquals(submission.is_accepted, false);
  assertEquals(submission.effective_attempt_id, null);
  assertEquals(submission.global_policy_revision, 1);

  // 切回 any：已有判定立即重新有效（无需重新评测）
  const back = await setProblemEffectiveVersionPolicy("ep-p1", {
    policy: { mode: "any" },
    expectedRevision: 1,
  });
  assertEquals(back.revision, 2);
  [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "ep-s1"),
  );
  assertEquals(submission.is_valid, true);
  assertEquals(submission.is_accepted, true);
  assertEquals(submission.global_policy_revision, 2);
  assertEquals(source.problem_id, "ep-p1");

  // data_revision 随两次切换递增
  const [revision] = await db.select().from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, problemScopeKey("ep-p1")),
  );
  assertEquals(revision.materialized_revision, 0);
  assertEquals(revision.data_revision >= 2, true);
});

Deno.test("policy: revision 乐观锁与版本校验", async () => {
  const { v1 } = await seedProblem("ep-p2", 992002);
  await seedProblem("ep-p3", 992003);

  // 过时 revision → 409
  await assertRejects(
    () =>
      setProblemEffectiveVersionPolicy("ep-p2", {
        policy: { mode: "any" },
        expectedRevision: 5,
      }),
    Error,
    "有效版本策略已被修改",
  );
  // 跨题版本 → 404
  await assertRejects(
    () =>
      setProblemEffectiveVersionPolicy("ep-p2", {
        policy: { mode: "exact", version_id: "ep-p3-v1" },
        expectedRevision: 0,
      }),
    Error,
    "要求版本不存在或未发布",
  );
  // 合法切换
  await setProblemEffectiveVersionPolicy("ep-p2", {
    policy: { mode: "exact", version_id: v1 },
    expectedRevision: 0,
  });
  // 不存在的题目 → 404
  await assertRejects(
    () =>
      setProblemEffectiveVersionPolicy("ghost", {
        policy: { mode: "any" },
        expectedRevision: 0,
      }),
    Error,
    "题目不存在",
  );
});

Deno.test("policy: 竞赛 exact(X) 同时固定作答版本", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("ep-p4", 992004);
  await seedContest("ep-c4", "ep-p4", v1);
  const source = await seedSubmissionWithResult({
    submissionId: "ep-s4",
    problemId: "ep-p4",
    versionId: v1,
    score: 10000,
    accepted: true,
    contestId: "ep-c4",
  });
  assertEquals(source.contest_id, "ep-c4");

  // 竞赛 exact(V2)：固定版本同步升级到 V2，竞赛口径失效（V2 无判定）
  const changed = await setContestProblemEffectiveVersionPolicy(
    "ep-c4",
    "ep-p4",
    {
      policy: { mode: "exact", version_id: v2 },
      expectedRevision: 0,
    },
  );
  assertEquals(changed.revision, 1);
  const [cp] = await db.select().from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, "ep-c4"),
      eq(contestProblems.problem_id, "ep-p4"),
    ),
  );
  assertEquals(cp.pinned_version_id, v2);
  assertEquals(cp.required_version_id, v2);

  const [submission] = await db.select().from(submissions).where(
    eq(submissions.id, "ep-s4"),
  );
  // 题库口径不受竞赛策略影响（默认 any → 仍通过）
  assertEquals(submission.is_accepted, true);
  assertEquals(submission.is_contest_valid, false);
  assertEquals(submission.contest_policy_revision, 1);
});

Deno.test("policy: 单独升级竞赛固定版本与现有 exact 冲突 → 409", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("ep-p5", 992005);
  await seedContest("ep-c5", "ep-p5", v1);
  await db.update(contestProblems).set({
    effective_version_mode: "exact",
    required_version_id: v1,
    effective_policy_revision: 3,
  }).where(
    and(
      eq(contestProblems.contest_id, "ep-c5"),
      eq(contestProblems.problem_id, "ep-p5"),
    ),
  );

  // 只升级固定版本、不给新策略 → 409（不静默改动策略）
  await assertRejects(
    () =>
      upgradeContestProblemPinnedVersion("ep-c5", "ep-p5", {
        versionId: v2,
      }),
    Error,
    "冲突",
  );

  // 同时给出 exact(V2) → 成功
  const upgraded = await upgradeContestProblemPinnedVersion("ep-c5", "ep-p5", {
    versionId: v2,
    policy: { mode: "exact", version_id: v2 },
    expectedRevision: 3,
  });
  assertEquals(upgraded.pinned_version_id, v2);
  assertEquals(upgraded.revision, 4);
  const [cp] = await db.select().from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, "ep-c5"),
      eq(contestProblems.problem_id, "ep-p5"),
    ),
  );
  assertEquals(cp.pinned_version_id, v2);
  assertEquals(cp.required_version_id, v2);

  // 升级到未发布/不存在的版本 → 404
  await assertRejects(
    () =>
      upgradeContestProblemPinnedVersion("ep-c5", "ep-p5", {
        versionId: "ghost",
      }),
    Error,
    "目标版本不存在或未发布",
  );
});

Deno.test("policy: 竞赛 any 策略下单独升级固定版本不改策略", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("ep-p6", 992006);
  await seedContest("ep-c6", "ep-p6", v1);
  const upgraded = await upgradeContestProblemPinnedVersion("ep-c6", "ep-p6", {
    versionId: v2,
  });
  assertEquals(upgraded.policy.mode, "any");
  assertEquals(upgraded.pinned_version_id, v2);
  const [cp] = await db.select().from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, "ep-c6"),
      eq(contestProblems.problem_id, "ep-p6"),
    ),
  );
  assertEquals(cp.effective_version_mode, "any");
  assertEquals(cp.required_version_id, null);
  // 固定版本升级本身不撤销旧成绩
  assertEquals(cp.pinned_version_id, v2);
});
