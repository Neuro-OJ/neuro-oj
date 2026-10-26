import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assignmentItems,
  assignmentRecipients,
  assignments,
  contests,
  domainFeatureIntervals,
  domainProblemBindings,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import { recomputeSubmissionProjection } from "../../../evaluations/index.ts";
import { createApp } from "../../../../app.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { signToken } from "../../../access/identity/index.ts";
import {
  createAssignment,
  getTeachingSubmissionAttempts,
  listAssignmentItemSubmissions,
  publishAssignment,
  removeClassroomMember,
  setClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture(objective = false) {
  const f = await assignmentFixture();
  f.versionId = crypto.randomUUID();
  await f.db.insert(problemVersions).values({
    id: f.versionId,
    problem_id: f.problemId,
    version: 2,
    published_at: new Date().toISOString(),
    content: objective
      ? {
        kind: "objective",
        title: "客观教学",
        description: "题面",
        questions: [],
      }
      : { kind: "oi", title: "OI教学", description: "题面" },
  });
  await f.db.update(problems).set({
    judge_type: objective ? "dual" : "oi",
    is_objective: objective,
    latest_version_id: f.versionId,
  })
    .where(eq(problems.id, f.problemId));
  const assignment = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(
    f.school.slug,
    assignment.id,
    f.teacher,
    0,
    "publish-evidence",
  );
  const [item] = await f.db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, assignment.id),
  );
  return { ...f, assignmentId: assignment.id, itemId: item.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function submit(
  f: Fixture,
  options: { at?: string; contestId?: string; objective?: boolean } = {},
) {
  const id = crypto.randomUUID(),
    fields = {
      id,
      domain_id: f.school.id,
      domain_problem_binding_id: f.bindingId,
      user_id: f.student,
      submitted_version_id: f.versionId,
      created_at: options.at ?? new Date().toISOString(),
      contest_id: options.contestId,
      version_origin: "known" as const,
    };
  if (options.objective) {
    await f.db.insert(objectiveSubmissions).values({
      ...fields,
      paper_id: f.problemId,
      answers: { answer: "student input" },
      submission_type: "practice",
    });
  } else {await f.db.insert(submissions).values({
      ...fields,
      problem_id: f.problemId,
      language: "cpp",
      code: "student code",
    });}
  return id;
}
async function grade(
  f: Fixture,
  id: string,
  sequence: number,
  score: number,
  options: { objective?: boolean; platform?: boolean } = {},
) {
  const attempt = crypto.randomUUID(), now = new Date().toISOString();
  await f.db.insert(evaluationAttempts).values({
    id: attempt,
    submission_id: options.objective ? null : id,
    objective_submission_id: options.objective ? id : null,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    sequence,
    source: sequence === 0 ? "initial" : "rejudge",
    state: options.platform ? "error" : "finished",
    result_kind: options.platform ? "platform_error" : "graded",
    score,
    accepted: score === 10000,
    created_at: now,
    finished_at: now,
    output: "SECRET evaluator",
    details: {
      answer: "SECRET answer",
      oi: {
        verdict: score === 10000 ? "AC" : "WA",
        score: score / 100,
        max_score: 100,
        input: "SECRET input",
        subtasks: [{
          id: "s1",
          score: 20,
          max_score: 100,
          verdict: "WA",
          answer: "SECRET",
          cases: [{
            case_id: "1",
            verdict: "WA",
            time_ms: 8,
            memory_kb: 16,
            input: "SECRET",
            output: "SECRET",
            answer: "SECRET",
          }],
        }],
      },
    },
  });
  if (!options.platform) {
    const key = options.objective
      ? submissionVersionResults.objective_submission_id
      : submissionVersionResults.submission_id;
    const [current] = await f.db.select().from(submissionVersionResults).where(
      eq(key, id),
    );
    if (current) {
      await f.db.update(submissionVersionResults).set({
        current_attempt_id: attempt,
        updated_at: now,
      })
        .where(eq(submissionVersionResults.id, current.id));
    } else {await f.db.insert(submissionVersionResults).values({
        id: crypto.randomUUID(),
        submission_id: options.objective ? null : id,
        objective_submission_id: options.objective ? id : null,
        problem_id: f.problemId,
        problem_version_id: f.versionId,
        current_attempt_id: attempt,
        updated_at: now,
      });}
    await recomputeSubmissionProjection(f.db, {
      kind: options.objective ? "objective" : "submission",
      id,
      problem_id: f.problemId,
      domain_problem_binding_id: f.bindingId,
      contest_id: null,
    });
  }
  return attempt;
}
const cell = (
  f: Fixture,
  actor = f.teacher,
  scope: "on_time" | "current" = "on_time",
  page = 1,
) =>
  listAssignmentItemSubmissions(
    f.school.slug,
    f.assignmentId,
    f.student,
    f.itemId,
    actor,
    { scope, page },
  );
const history = (
  f: Fixture,
  id: string,
  actor = f.teacher,
  kind: "submission" | "objective" = "submission",
  page = 1,
) =>
  getTeachingSubmissionAttempts(
    f.school.slug,
    f.classroom.id,
    id,
    kind,
    actor,
    page,
  );

Deno.test("教学单元依据：接收者、发布时间、按时补做与离班区间保持同域学情口径", async () => {
  const f = await fixture();
  await submit(f, { at: new Date(Date.now() - 60000).toISOString() });
  const ontime = await submit(f);
  const late = await submit(f, {
    at: new Date(Date.now() + 2000).toISOString(),
  });
  await f.db.update(assignments).set({
    deadline_at: new Date(Date.now() + 1000).toISOString(),
  })
    .where(eq(assignments.id, f.assignmentId));
  assertEquals((await cell(f)).data.map((r) => r.id), [ontime]);
  assertEquals((await cell(f, f.teacher, "current")).data.map((r) => r.id), [
    late,
    ontime,
  ]);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  assertEquals((await cell(f, f.teacher, "current")).data.map((r) => r.id), [
    ontime,
  ]);
  await assertRejects(
    () =>
      listAssignmentItemSubmissions(
        f.other.slug,
        f.assignmentId,
        f.student,
        f.itemId,
        f.owner,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      listAssignmentItemSubmissions(
        f.school.slug,
        f.assignmentId,
        f.assistant,
        f.itemId,
        f.teacher,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      listAssignmentItemSubmissions(
        f.school.slug,
        f.assignmentId,
        f.student,
        "wrong-item",
        f.teacher,
      ),
    NotFoundError,
  );
  await assertRejects(() => cell(f, f.student), ForbiddenError);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  await assertRejects(() => cell(f, f.assistant), ForbiddenError);
});

Deno.test("教学正式沿革：降分与平台错误可追溯，当前正式候选独立标记，OI白名单无原始数据", async () => {
  const f = await fixture(), id = await submit(f);
  const original = await grade(f, id, 0, 10000),
    current = await grade(f, id, 1, 2000);
  const failed = await grade(f, id, 2, 9999, { platform: true });
  const row = (await cell(f)).data[0];
  assertEquals(row.score, 2000);
  assertEquals(row.candidate_attempt_ids, [current]);
  const attempts = await history(f, id);
  assertEquals(attempts.data.map((r) => r.id), [failed, current, original]);
  assertEquals(attempts.data.map((r) => r.current_formal), [
    false,
    true,
    false,
  ]);
  assertEquals(attempts.data.map((r) => r.score), [null, 2000, 10000]);
  const oi = attempts.data[1].oi!;
  assert(Array.isArray(oi.subtasks));
  assertEquals(oi.subtasks[0], {
    id: "s1",
    score: 20,
    max_score: 100,
    verdict: "WA",
    cases: [{ case_id: "1", verdict: "WA", time_ms: 8, memory_kb: 16 }],
  });
  assertEquals(JSON.stringify(attempts).includes("SECRET"), false);
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  const revoked = await history(f, id);
  assertEquals(revoked.resource_available, false);
  assertEquals(revoked.data[1].score, 2000);
  assertEquals(revoked.data.every((r) => r.oi === null), true);
  assertEquals((await cell(f)).data[0].candidate_attempt_ids, []);
});

Deno.test("教学尝试：客观题只提供总分，无逐题判题或伪造OI明细；列表与尝试独立分页", async () => {
  const f = await fixture(true),
    objective = await submit(f, { objective: true });
  await grade(f, objective, 0, 6500, { objective: true });
  const result = await history(f, objective, f.teacher, "objective");
  assertEquals(result.data[0].oi, null);
  assertEquals(JSON.stringify(result).includes("SECRET"), false);
  for (let i = 0; i < 26; i++) await submit(f, { objective: true });
  assertEquals((await cell(f)).data.length, 25);
  assertEquals((await cell(f, f.teacher, "on_time", 2)).data.length, 2);
  assertEquals(
    (await history(f, objective, f.teacher, "objective", 2)).data.length,
    0,
  );
});

Deno.test("教学候选依据：exact 排除其他正式版本，教学停用期间提交不回填", async () => {
  const f = await fixture(), id = await submit(f);
  await grade(f, id, 0, 6500);
  const [oldVersion] = await f.db.select().from(problemVersions).where(
    eq(problemVersions.problem_id, f.problemId),
  )
    .orderBy(problemVersions.version);
  await f.db.update(domainProblemBindings).set({
    effective_version_mode: "exact",
    required_version_id: oldVersion.id,
    revision: 1,
  })
    .where(eq(domainProblemBindings.id, f.bindingId));
  assertEquals((await cell(f)).data[0].candidate_attempt_ids, []);
  assertEquals((await history(f, id)).data[0].matches_policy, false);
  await f.db.insert(domainFeatureIntervals).values({
    id: crypto.randomUUID(),
    domain_id: f.school.id,
    feature: "assignment",
    disabled_at: new Date(Date.now() - 1000).toISOString(),
    enabled_at: new Date(Date.now() + 1000).toISOString(),
  });
  assertEquals((await cell(f)).total, 0);
});

Deno.test("教学依据 HTTP：教练不能读取进行中比赛沿革，实际组织者可查但不计作业候选", async () => {
  const f = await fixture(),
    contestId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(contests).values({
    id: contestId,
    domain_id: f.school.id,
    title: "OI保密",
    type: "oi",
    created_by: f.owner,
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  const id = await submit(f, { contestId });
  await grade(f, id, 0, 10000);
  assertEquals((await cell(f)).total, 0);
  await assertRejects(() => history(f, id), NotFoundError);
  const organizer = await cell(f, f.owner);
  assertEquals(organizer.total, 1);
  assertEquals(organizer.data[0].candidate_attempt_ids, []);
  assertEquals((await history(f, id, f.owner)).data[0].score, 10000);
  await initRedisForTest();
  const app = createApp(),
    token = await signToken({ sub: f.teacher, role: "user" });
  const path =
    `/api/v1/domains/${f.school.slug}/classrooms/${f.classroom.id}/submissions/submission/${id}/attempts`;
  const response = await jsonRequest(app, path, { token });
  assertEquals(response.status, 404);
  await f.db.update(contests).set({
    end_time: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(contests.id, contestId));
  const visible = await jsonRequest(app, path, { token });
  assertEquals(visible.status, 200);
  assertEquals(JSON.stringify(await visible.json()).includes("SECRET"), false);
  const list = await jsonRequest(
    app,
    `/api/v1/domains/${f.school.slug}/assignments/${f.assignmentId}/students/${f.student}/items/${f.itemId}/submissions`,
    { token },
  );
  assertEquals(list.status, 200);
  assertEquals((await cell(f)).data[0].candidate_attempt_ids.length, 1);
  await f.db.delete(assignmentRecipients).where(
    eq(assignmentRecipients.assignment_id, f.assignmentId),
  );
  await assertRejects(() => cell(f), NotFoundError);
});
