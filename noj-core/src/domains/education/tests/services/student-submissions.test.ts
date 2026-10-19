import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  contests,
  domainProblemBindings,
  evaluationAttempts,
  objectiveSubmissions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import { setMemberRole } from "../../../workspace/index.ts";
import { recomputeSubmissionProjection } from "../../../submission/index.ts";
import {
  createAssignment,
  getClassroomStudentSubmission,
  listClassroomStudentSubmissions,
  publishAssignment,
  removeClassroomMember,
  setClassroomMember,
  transferClassroom,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function code(
  f: Awaited<ReturnType<typeof assignmentFixture>>,
  options: {
    domainId?: string;
    createdAt?: string;
    contestId?: string;
    artifact?: boolean;
  } = {},
) {
  const id = crypto.randomUUID();
  let bindingId = f.bindingId;
  if (options.domainId && options.domainId !== f.school.id) {
    // 跨域原提交仍引用真实目标绑定；源共享现状不恢复教师的其他域读取资格。
    bindingId = crypto.randomUUID();
    const now = new Date().toISOString();
    await f.db.insert(domainProblemBindings).values({
      id: bindingId,
      domain_id: options.domainId,
      problem_id: f.problemId,
      kind: "shared",
      visibility: "members",
      created_by: f.owner,
      created_at: now,
      updated_at: now,
    });
  }
  await f.db.insert(submissions).values({
    id,
    domain_id: options.domainId ?? f.school.id,
    domain_problem_binding_id: bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python",
    code: "student source",
    artifact_storage_url: options.artifact
      ? "noj-storage://sensitive/file.zip"
      : null,
    contest_id: options.contestId,
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: options.createdAt ?? new Date().toISOString(),
  });
  return id;
}

Deno.test("教学提交：教练全部同域提交、助教独立源码授权、错误域拒绝且撤职即时失权", async () => {
  const f = await assignmentFixture();
  const same = await code(f), other = await code(f, { domainId: f.other.id });
  assertEquals(
    (await listClassroomStudentSubmissions(
      f.school.slug,
      f.classroom.id,
      f.student,
      f.teacher,
    )).total,
    1,
  );
  assertEquals(
    (await getClassroomStudentSubmission(
      f.school.slug,
      f.classroom.id,
      same,
      "submission",
      f.teacher,
    )).code,
    "student source",
  );
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        other,
        "submission",
        f.teacher,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.other.slug,
        f.classroom.id,
        same,
        "submission",
        f.owner,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        same,
        "submission",
        f.student,
      ),
    ForbiddenError,
  );
  await setClassroomMember(f.school.slug, f.classroom.id, f.teacher, f.assistant, 1, {});
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        same,
        "submission",
        f.assistant,
      ),
    ForbiddenError,
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  assertEquals(
    (await getClassroomStudentSubmission(
      f.school.slug,
      f.classroom.id,
      same,
      "submission",
      f.assistant,
    )).code,
    "student source",
  );
  await transferClassroom(f.school.slug, f.classroom.id, f.owner, f.owner, 2);
  await setMemberRole(f.school.slug, f.owner, f.teacher, "member");
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        same,
        "submission",
        f.teacher,
      ),
    NotFoundError,
  );
});

Deno.test("教学提交：学生离班保留作业依据，不开放发布前练习或离班后个人提交", async () => {
  const f = await assignmentFixture();
  const previous = await code(f, {
    createdAt: new Date(Date.now() - 60000).toISOString(),
  });
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "publish");
  const evidence = await code(f);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  const later = await code(f, {
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  assertEquals(
    (await getClassroomStudentSubmission(
      f.school.slug,
      f.classroom.id,
      evidence,
      "submission",
      f.teacher,
    )).code,
    "student source",
  );
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        previous,
        "submission",
        f.teacher,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getClassroomStudentSubmission(
        f.school.slug,
        f.classroom.id,
        later,
        "submission",
        f.teacher,
      ),
    NotFoundError,
  );
  const list = await listClassroomStudentSubmissions(
    f.school.slug,
    f.classroom.id,
    f.student,
    f.teacher,
  );
  assertEquals(list.total, 1);
  assertEquals(list.data[0].id, evidence);
  assertEquals("code" in list.data[0], false);
});

Deno.test("教学提交：域教练按本域比赛管理权限读取，作者标记不能替代当前域角色", async () => {
  const f = await assignmentFixture(), contestId = crypto.randomUUID();
  await f.db.insert(contests).values({
    id: contestId, domain_id: f.school.id, title: "保密比赛", type: "oi", created_by: f.owner,
    start_time: new Date(Date.now() - 60000).toISOString(), end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const id = await code(f, { contestId });
  assertEquals((await listClassroomStudentSubmissions(f.school.slug, f.classroom.id, f.student, f.teacher)).total, 1);
  assertEquals((await getClassroomStudentSubmission(f.school.slug, f.classroom.id, id, "submission", f.teacher)).code, "student source");
  await setMemberRole(f.school.slug, f.owner, f.teacher, "member");
  await assertRejects(() => getClassroomStudentSubmission(f.school.slug, f.classroom.id, id, "submission", f.teacher), NotFoundError);
  await f.db.update(contests).set({ created_by: f.teacher }).where(eq(contests.id, contestId));
  await assertRejects(() => getClassroomStudentSubmission(f.school.slug, f.classroom.id, id, "submission", f.teacher), NotFoundError);
  await setMemberRole(f.school.slug, f.owner, f.teacher, "coach");
  assertEquals((await getClassroomStudentSubmission(f.school.slug, f.classroom.id, id, "submission", f.teacher)).code, "student source");
  await f.db.update(contests).set({ end_time: new Date(Date.now() - 1000).toISOString() }).where(eq(contests.id, contestId));
  assertEquals((await listClassroomStudentSubmissions(f.school.slug, f.classroom.id, f.student, f.teacher)).total, 1);
});

Deno.test("教学提交：客观题原答案可读，产物不暴露存储地址；列表和详情均不含评测输出", async () => {
  const f = await assignmentFixture(), id = crypto.randomUUID();
  await f.db.insert(objectiveSubmissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    paper_id: f.problemId,
    user_id: f.student,
    answers: { answer: "student input" },
    submission_type: "practice",
    created_at: new Date().toISOString(),
    submitted_version_id: f.versionId,
    version_origin: "known",
  });
  const detail = await getClassroomStudentSubmission(
    f.school.slug,
    f.classroom.id,
    id,
    "objective",
    f.teacher,
  );
  assertEquals(detail.answers, { answer: "student input" });
  assertEquals(detail.code, null);
  const artifact = await code(f, { artifact: true });
  const item = await getClassroomStudentSubmission(
    f.school.slug,
    f.classroom.id,
    artifact,
    "submission",
    f.teacher,
  );
  assertEquals(item.has_artifact, true);
  assertEquals(item.code, null);
  assertEquals(JSON.stringify(item).includes("sensitive"), false);
  assertEquals("output" in item, false);
  assertEquals("details" in item, false);
  assertEquals(item.display_ref, "1001");
  const gradedId = await code(f),
    attemptId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.transaction(async (tx) => {
    await tx.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: gradedId,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      score: 6500,
      output: "secret evaluator output",
      details: {
        oi: { verdict: "WA", cases: [{ input: "secret testcase" }] },
        expected: "secret standard answer",
      },
      created_at: now,
    });
    await tx.insert(submissionVersionResults).values({
      id: crypto.randomUUID(),
      submission_id: gradedId,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      current_attempt_id: attemptId,
      updated_at: now,
    });
    await recomputeSubmissionProjection(tx, {
      kind: "submission",
      id: gradedId,
      problem_id: f.problemId,
      domain_problem_binding_id: f.bindingId,
      contest_id: null,
    });
  });
  const graded = await getClassroomStudentSubmission(
    f.school.slug,
    f.classroom.id,
    gradedId,
    "submission",
    f.teacher,
  );
  assertEquals(graded.score, 6500);
  assertEquals(graded.verdict, "WA");
  assertEquals(JSON.stringify(graded).includes("secret"), false);
  assertEquals(
    (await listClassroomStudentSubmissions(
      f.school.slug,
      f.classroom.id,
      f.student,
      f.teacher,
      { kind: "objective" },
    )).total,
    1,
  );
});
