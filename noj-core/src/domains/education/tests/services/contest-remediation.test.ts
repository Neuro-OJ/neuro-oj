import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  assignments,
  auditLogs,
  contestParticipants,
  contestProblems,
  contests,
  evaluationAttempts,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { publishDomainContestRanking } from "../../../contest/index.ts";
import {
  createContestRemediation,
  previewContestRemediation,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture(),
    now = new Date().toISOString(),
    id = crypto.randomUUID();
  await f.db.insert(contests).values({
    id,
    domain_id: f.school.id,
    type: "kaggle",
    kind: "public",
    title: "基础比赛",
    ranking_visibility: "public",
    is_public: true,
    config: { scoreboard_scope: "full" },
    created_by: f.owner,
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await f.db.insert(contestProblems).values({
    contest_id: id,
    problem_id: f.problemId,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    label: "A",
    score: 10000,
    pinned_version_id: f.versionId,
  });
  await f.db.insert(contestParticipants).values({
    contest_id: id,
    user_id: f.student,
    registered_at: now,
  });
  const submissionId = crypto.randomUUID(), attemptId = crypto.randomUUID();
  await f.db.insert(submissions).values({
    id: submissionId,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    contest_id: id,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python3",
    code: "student answer",
    status: "finished",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: new Date(Date.now() - 45000).toISOString(),
  });
  await f.db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: 10000,
    accepted: false,
    created_at: now,
  });
  await f.db.update(submissions).set({
    latest_attempt_id: attemptId,
    contest_effective_attempt_id: attemptId,
    is_contest_valid: true,
  }).where(eq(submissions.id, submissionId));
  return { ...f, contestId: id, submissionId, attemptId };
}

Deno.test("比赛补题：满分不能反推 AC，正式快照沿用冻结尝试，独立任务保留比赛来源", async () => {
  const f = await fixture();
  await f.db.update(contests).set({
    end_time: new Date(Date.now() - 30000).toISOString(),
  }).where(eq(contests.id, f.contestId));
  await publishDomainContestRanking(f.school.slug, f.contestId, f.owner, {});
  const rule = {
    contest_id: f.contestId,
    ranking_source: "official" as const,
    requirement: "accepted" as const,
  };
  const preview = await previewContestRemediation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    rule,
  );
  assertEquals(preview.students.map((s) => s.user_id), [f.student]);
  assertEquals(preview.source.snapshot_version, 1);
  assertEquals(preview.items[0].id, f.problemId);
  assertEquals(
    (await previewContestRemediation(f.school.slug, f.classroom.id, f.teacher, {
      ...rule,
      requirement: "min_score",
      minimum_score: 6000,
    })).students.length,
    0,
  );
  const now = new Date().toISOString(), newer = crypto.randomUUID();
  await f.db.insert(evaluationAttempts).values({
    id: newer,
    submission_id: f.submissionId,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    sequence: 1,
    source: "rejudge",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: 1000,
    accepted: false,
    created_at: now,
  });
  await f.db.update(submissions).set({
    latest_attempt_id: newer,
    contest_effective_attempt_id: newer,
  }).where(eq(submissions.id, f.submissionId));
  assertEquals(
    (await previewContestRemediation(f.school.slug, f.classroom.id, f.teacher, {
      ...rule,
      requirement: "min_score",
      minimum_score: 6000,
    })).students.length,
    0,
  );
  const input = {
    ...rule,
    title: "赛后补题",
    preview_token: preview.preview_token,
    target_student_ids: [f.student],
    item_ids: [f.problemId],
  };
  const draft = await createContestRemediation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    preview.source.revision,
    "contest-remediation",
    input,
  );
  assertEquals(draft.state, "draft");
  assertEquals(draft.source_contest_id, f.contestId);
  assertEquals(
    (await createContestRemediation(
      f.school.slug,
      f.classroom.id,
      f.teacher,
      preview.source.revision,
      "contest-remediation",
      input,
    )).id,
    draft.id,
  );
  assertEquals((await f.db.select().from(assignments)).length, 1);
  assertEquals((await f.db.select().from(submissions)).length, 1);
  const basis = (await f.db.select().from(auditLogs)).map((r) =>
    r.detail as Record<string, unknown>
  )
    .filter((r) => r.operation === "assignment.contest_remediation");
  assertEquals(basis.length, 1);
  assertEquals(basis[0].snapshot_version, 1);
  assertEquals(basis[0].ranking_source, "official");
});

Deno.test("比赛补题：教练不能越过 OI 保密和本人榜，错误域及学生被拒", async () => {
  const f = await fixture(),
    rule = {
      contest_id: f.contestId,
      ranking_source: "live" as const,
      requirement: "accepted" as const,
    };
  await assertRejects(
    () =>
      previewContestRemediation(f.other.slug, f.classroom.id, f.teacher, rule),
    NotFoundError,
  );
  await assertRejects(
    () =>
      previewContestRemediation(f.school.slug, f.classroom.id, f.student, rule),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      previewContestRemediation(f.school.slug, f.classroom.id, f.teacher, rule),
    ForbiddenError,
  );
  await f.db.update(contests).set({ type: "oi" }).where(
    eq(contests.id, f.contestId),
  );
  await assertRejects(
    () =>
      previewContestRemediation(f.school.slug, f.classroom.id, f.teacher, rule),
    NotFoundError,
  );
  // 域负责人也是实际组织者，能够处理获授权成绩；教师身份本身没有该权限。
  assertEquals(
    (await previewContestRemediation(
      f.school.slug,
      f.classroom.id,
      f.owner,
      rule,
    )).students.length,
    1,
  );
});
