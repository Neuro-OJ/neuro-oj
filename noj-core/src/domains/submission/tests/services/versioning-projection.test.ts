/**
 * 有效成绩投影写入服务测试（Handbook §3.1、§3.2、§1.3）。
 *
 * 这里验证的是「读候选 → 取策略 → 算 → 写」整条链路：
 * 跨版本保留、未知版本桶、平台错误不参与、通过指针与分数指针分离、
 * 题库与竞赛两个作用域独立，以及策略切换后的整题重算与 revision 递增。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  queryProjectionRevisions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  bumpProjectionRevision,
  computeSubmissionProjection,
  listProblemProjectionSources,
  loadCurrentVersionResults,
  problemScopeKey,
  type ProjectionSource,
  recomputeContestProblemProjections,
  recomputeProblemProjections,
  recomputeSubmissionProjection,
  upsertCurrentVersionResult,
} from "../../services/versioning/projection.ts";

const now = new Date().toISOString();

/** 建题 + 两个版本，返回版本 ID。 */
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
  await db.insert(problemVersions).values([
    {
      id: `${problemId}-v1`,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    },
    {
      id: `${problemId}-v2`,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    },
  ]);
  await db.update(problems).set({ latest_version_id: `${problemId}-v2` })
    .where(eq(problems.id, problemId));
  return { v1: `${problemId}-v1`, v2: `${problemId}-v2` };
}

/** 建一条普通提交（已知提交时版本）。 */
async function seedSubmission(input: {
  id: string;
  problemId: string;
  versionId: string;
  contestId?: string | null;
}): Promise<ProjectionSource> {
  await getDb().insert(submissions).values({
    id: input.id,
    user_id: "0",
    problem_id: input.problemId,
    contest_id: input.contestId ?? null,
    language: "python",
    code: "print(1)",
    submitted_version_id: input.versionId,
    version_origin: "known",
    created_at: now,
  });
  return {
    kind: "submission",
    id: input.id,
    problem_id: input.problemId,
    contest_id: input.contestId ?? null,
  };
}

/** 建一次 graded 终态尝试，并把它写成分版本当前判定。 */
async function seedAttempt(input: {
  attemptId: string;
  source: ProjectionSource;
  problemVersionId: string | null;
  score: number;
  accepted: boolean;
  sequence: number;
  source_kind?: "initial" | "rejudge" | "upgrade" | "legacy_import";
  resultKind?: "graded" | "platform_error";
}): Promise<void> {
  const db = getDb();
  const resultKind = input.resultKind ?? "graded";
  await db.insert(evaluationAttempts).values({
    id: input.attemptId,
    submission_id: input.source.kind === "submission" ? input.source.id : null,
    objective_submission_id: input.source.kind === "objective"
      ? input.source.id
      : null,
    problem_id: input.source.problem_id,
    problem_version_id: input.problemVersionId,
    sequence: input.sequence,
    source: input.source_kind ?? "initial",
    state: resultKind === "graded" ? "finished" : "error",
    result_kind: resultKind,
    result_status: resultKind === "graded" ? "finished" : "error",
    score: input.score,
    accepted: input.accepted,
    created_at: now,
  });
  await upsertCurrentVersionResult(db, {
    source: input.source,
    problemVersionId: input.problemVersionId,
    attemptId: input.attemptId,
  });
}

Deno.test("projection: any 采用全部版本，exact(X) 只用 X", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("proj-p1", 930001);
  const source = await seedSubmission({
    id: "proj-s1",
    problemId: "proj-p1",
    versionId: v1,
  });
  // V1 AC（10000）+ V2 WA（1000）
  await seedAttempt({
    attemptId: "proj-s1-a1",
    source,
    problemVersionId: v1,
    score: 10000,
    accepted: true,
    sequence: 0,
  });
  await seedAttempt({
    attemptId: "proj-s1-a2",
    source,
    problemVersionId: v2,
    score: 1000,
    accepted: false,
    sequence: 1,
    source_kind: "rejudge",
  });

  // any：保留 V1 的 AC
  let plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, true);
  assertEquals(plan.global.is_accepted, true);
  assertEquals(plan.global.effective_attempt_id, "proj-s1-a1");

  // exact(V2)：只有 V2 候选，不通过
  await db.update(problems).set({
    effective_version_mode: "exact",
    required_version_id: v2,
    effective_policy_revision: 1,
  }).where(eq(problems.id, "proj-p1"));
  plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, true);
  assertEquals(plan.global.is_accepted, false);
  assertEquals(plan.global.effective_attempt_id, "proj-s1-a2");
  assertEquals(plan.global.accepted_attempt_id, null);
  assertEquals(plan.global_policy_revision, 1);

  // 再次用 V1 重测失败：同版本判定被替换（V1 AC → V1 WA）
  await seedAttempt({
    attemptId: "proj-s1-a3",
    source,
    problemVersionId: v1,
    score: 0,
    accepted: false,
    sequence: 2,
    source_kind: "rejudge",
  });
  await db.update(problems).set({
    effective_version_mode: "any",
    required_version_id: null,
    effective_policy_revision: 2,
  }).where(eq(problems.id, "proj-p1"));
  plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_accepted, false);
  // 最高分是 V2 的 1000（V1 已被 WA 替换）
  assertEquals(plan.global.effective_attempt_id, "proj-s1-a2");

  // 用 V2 重测通过 → 两个口径都通过
  await seedAttempt({
    attemptId: "proj-s1-a4",
    source,
    problemVersionId: v2,
    score: 10000,
    accepted: true,
    sequence: 3,
    source_kind: "rejudge",
  });
  plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_accepted, true);
  assertEquals(plan.global.effective_attempt_id, "proj-s1-a4");
});

Deno.test("projection: 未知版本桶只在 any 下有效", async () => {
  const db = getDb();
  await seedProblem("proj-p2", 930002);
  const source = await seedSubmission({
    id: "proj-s2",
    problemId: "proj-p2",
    versionId: "proj-p2-v1",
  });
  // 迁移历史：未知版本的 AC
  await seedAttempt({
    attemptId: "proj-s2-a1",
    source,
    problemVersionId: null,
    score: 10000,
    accepted: true,
    sequence: 0,
    source_kind: "legacy_import",
  });

  let plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, true);
  assertEquals(plan.global.is_accepted, true);

  await db.update(problems).set({
    effective_version_mode: "exact",
    required_version_id: "proj-p2-v1",
    effective_policy_revision: 1,
  }).where(eq(problems.id, "proj-p2"));
  plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, false);
  assertEquals(plan.global.is_accepted, false);
  assertEquals(plan.global.effective_attempt_id, null);
});

Deno.test("projection: 平台错误与在途尝试不参与选择", async () => {
  const db = getDb();
  const { v1 } = await seedProblem("proj-p3", 930003);
  const source = await seedSubmission({
    id: "proj-s3",
    problemId: "proj-p3",
    versionId: v1,
  });
  await seedAttempt({
    attemptId: "proj-s3-err",
    source,
    problemVersionId: v1,
    score: 10000,
    accepted: true,
    sequence: 0,
    resultKind: "platform_error",
  });
  const results = await loadCurrentVersionResults(db, source);
  assertEquals(results.length, 1);
  const plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, false);
});

Deno.test("projection: 分数指针与通过指针分离（最高分可以是不通过）", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("proj-p4", 930004);
  const source = await seedSubmission({
    id: "proj-s4",
    problemId: "proj-p4",
    versionId: v1,
  });
  await seedAttempt({
    attemptId: "proj-s4-ac",
    source,
    problemVersionId: v1,
    score: 3000,
    accepted: true,
    sequence: 1,
  });
  await seedAttempt({
    attemptId: "proj-s4-partial",
    source,
    problemVersionId: v2,
    score: 9000,
    accepted: false,
    sequence: 2,
    source_kind: "rejudge",
  });
  const plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, true);
  assertEquals(plan.global.is_accepted, true);
  assertEquals(plan.global.effective_attempt_id, "proj-s4-partial");
  assertEquals(plan.global.accepted_attempt_id, "proj-s4-ac");
});

Deno.test("projection: 题库与竞赛两个作用域独立计算", async () => {
  const db = getDb();
  const { v1, v2 } = await seedProblem("proj-p5", 930005);
  await db.insert(contests).values({
    id: "proj-c5",
    public_id: "ct-proj5",
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
    contest_id: "proj-c5",
    problem_id: "proj-p5",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: v1,
  });
  const source = await seedSubmission({
    id: "proj-s5",
    problemId: "proj-p5",
    versionId: v1,
    contestId: "proj-c5",
  });
  await seedAttempt({
    attemptId: "proj-s5-a1",
    source,
    problemVersionId: v1,
    score: 10000,
    accepted: true,
    sequence: 0,
  });

  // 竞赛固定 V1 + exact(V1)：与题库 any 各自独立，都通过
  await db.update(contestProblems).set({
    effective_version_mode: "exact",
    required_version_id: v1,
    effective_policy_revision: 4,
  }).where(
    and(
      eq(contestProblems.contest_id, "proj-c5"),
      eq(contestProblems.problem_id, "proj-p5"),
    ),
  );
  let plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.is_accepted, true);
  assertEquals(plan.contest.is_valid, true);
  assertEquals(plan.contest.is_accepted, true);
  assertEquals(plan.contest_policy_revision, 4);

  // 竞赛把固定作答版本升级到 V2 并保持 exact(V2)：V2 尚无判定 →
  // 竞赛口径立即失效，而题库口径不受影响（独立作用域 + 立即生效）
  await db.update(contestProblems).set({
    pinned_version_id: v2,
    effective_version_mode: "exact",
    required_version_id: v2,
    effective_policy_revision: 5,
  }).where(
    and(
      eq(contestProblems.contest_id, "proj-c5"),
      eq(contestProblems.problem_id, "proj-p5"),
    ),
  );
  plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.contest.is_valid, false);
  assertEquals(plan.contest.is_accepted, false);
  assertEquals(plan.contest.effective_attempt_id, null);
  assertEquals(plan.contest_policy_revision, 5);
  assertEquals(plan.global.is_accepted, true);

  // 竞赛切回 any 后立即恢复（不依赖 TTL/异步刷新）
  await db.update(contestProblems).set({
    effective_version_mode: "any",
    required_version_id: null,
    effective_policy_revision: 6,
  }).where(
    and(
      eq(contestProblems.contest_id, "proj-c5"),
      eq(contestProblems.problem_id, "proj-p5"),
    ),
  );
  plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.contest.is_valid, true);
  assertEquals(plan.contest.is_accepted, true);
  assertEquals(plan.contest_policy_revision, 6);
});

Deno.test("projection: 写入投影并递增题目/竞赛 revision", async () => {
  const db = getDb();
  const { v1 } = await seedProblem("proj-p6", 930006);
  await db.insert(contests).values({
    id: "proj-c6",
    public_id: "ct-proj6",
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
    contest_id: "proj-c6",
    problem_id: "proj-p6",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: v1,
  });
  const source = await seedSubmission({
    id: "proj-s6",
    problemId: "proj-p6",
    versionId: v1,
    contestId: "proj-c6",
  });
  await seedAttempt({
    attemptId: "proj-s6-a1",
    source,
    problemVersionId: v1,
    score: 8800,
    accepted: false,
    sequence: 0,
  });

  const plan = await recomputeSubmissionProjection(db, source);
  assertEquals(plan.global.is_valid, true);

  const [row] = await db.select().from(submissions).where(
    eq(submissions.id, "proj-s6"),
  );
  assertEquals(row.is_valid, true);
  assertEquals(row.is_accepted, false);
  assertEquals(row.effective_attempt_id, "proj-s6-a1");
  assertEquals(row.accepted_attempt_id, null);
  assertEquals(row.is_contest_valid, true);
  assertEquals(row.contest_effective_attempt_id, "proj-s6-a1");
  assertEquals(row.global_policy_revision, 0);

  const revisions = await db.select().from(queryProjectionRevisions);
  const problemRev = revisions.find((r) =>
    r.scope_key === problemScopeKey("proj-p6")
  );
  assertEquals(problemRev?.data_revision, 1);
  assertEquals(problemRev?.materialized_revision, 0);
  await bumpProjectionRevision(db, problemScopeKey("proj-p6"));
  const again = await db.select().from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, problemScopeKey("proj-p6")),
  );
  assertEquals(again[0].data_revision, 2);
});

Deno.test("projection: 整题重算覆盖两类提交", async () => {
  const db = getDb();
  const { v1 } = await seedProblem("proj-p7", 930007);
  const s1 = await seedSubmission({
    id: "proj-s7",
    problemId: "proj-p7",
    versionId: v1,
  });
  await seedAttempt({
    attemptId: "proj-s7-a1",
    source: s1,
    problemVersionId: v1,
    score: 5000,
    accepted: false,
    sequence: 0,
  });
  // 客观题提交（同一套卷）
  await db.update(problems).set({ is_objective: true }).where(
    eq(problems.id, "proj-p7"),
  );
  await db.insert(objectiveSubmissions).values({
    id: "proj-o7",
    paper_id: "proj-p7",
    user_id: "0",
    submission_type: "practice",
    answers: {},
    status: "finished",
    score: 10000,
    details: {},
    submitted_version_id: v1,
    version_origin: "known",
    created_at: now,
  });
  const objectiveSource: ProjectionSource = {
    kind: "objective",
    id: "proj-o7",
    problem_id: "proj-p7",
    contest_id: null,
  };
  await seedAttempt({
    attemptId: "proj-o7-a1",
    source: objectiveSource,
    problemVersionId: v1,
    score: 10000,
    accepted: true,
    sequence: 0,
  });

  const sources = await listProblemProjectionSources(db, "proj-p7");
  assertEquals(sources.length, 2);

  const count = await recomputeProblemProjections(db, "proj-p7");
  assertEquals(count, 2);
  const [objectiveRow] = await db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, "proj-o7"),
  );
  assertEquals(objectiveRow.is_accepted, true);
  assertEquals(objectiveRow.is_valid, true);

  // 竞赛维度重算（本题没有竞赛提交）返回 0 且不报错
  assertEquals(
    await recomputeContestProblemProjections(db, "proj-c7", "proj-p7"),
    0,
  );
});

Deno.test("projection: 当前判定指针可替换（未知版本桶唯一）", async () => {
  const db = getDb();
  const { v1 } = await seedProblem("proj-p8", 930008);
  const source = await seedSubmission({
    id: "proj-s8",
    problemId: "proj-p8",
    versionId: v1,
  });
  await seedAttempt({
    attemptId: "proj-s8-a1",
    source,
    problemVersionId: v1,
    score: 1000,
    accepted: false,
    sequence: 0,
  });
  await seedAttempt({
    attemptId: "proj-s8-a2",
    source,
    problemVersionId: v1,
    score: 10000,
    accepted: true,
    sequence: 1,
    source_kind: "rejudge",
  });
  const rows = await db.select().from(submissionVersionResults).where(
    eq(submissionVersionResults.submission_id, "proj-s8"),
  );
  // 同版本只保留一行，指针指向最新判定
  assertEquals(rows.length, 1);
  assertEquals(rows[0].current_attempt_id, "proj-s8-a2");

  // 未知版本桶与已知版本桶并存
  await seedAttempt({
    attemptId: "proj-s8-legacy",
    source,
    problemVersionId: null,
    score: 100,
    accepted: false,
    sequence: 2,
    source_kind: "legacy_import",
  });
  const all = await db.select().from(submissionVersionResults).where(
    eq(submissionVersionResults.submission_id, "proj-s8"),
  );
  assertEquals(all.length, 2);
  const plan = await computeSubmissionProjection(db, source);
  assertEquals(plan.global.effective_attempt_id, "proj-s8-a2");
});
