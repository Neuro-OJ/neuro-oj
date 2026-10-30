import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  domains,
  evaluationAttempts,
  problemBindingHistory,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  importDomainProblem,
  listDomainProblems,
  resolveDomainProblem,
  setDomainProblemBindingState,
  setDomainProblemSharing,
} from "../../../problems/index.ts";
import { recomputeSubmissionProjection } from "../../../evaluations/index.ts";
import {
  createAssignment,
  createClassroom,
  getClassroomStudentSubmission,
  getMyAssignmentProgress,
  publishAssignment,
  setClassroomMember,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("资源下架：副本独立下架，保留学生代码及成绩；恢复沿用原绑定", async () => {
  const f = await assignmentFixture();
  await f.db.update(domains).set({
    configuration: { ...f.school.configuration, access: "public" },
  }).where(eq(domains.id, f.school.id));
  await setDomainProblemBindingState(f.school.slug, "1001", f.owner, 0, {
    disabled: false,
    visibility: "public",
    reason: "公开源题",
  });
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const imported = await importDomainProblem(
    f.other.slug,
    "class-school:1001",
    f.owner,
  );
  const resource = await resolveDomainProblem(
    f.other.slug,
    imported.reference.display_ref,
    f.owner,
  );
  const localRef = String(resource.problem.number);
  const classroom = await createClassroom(f.other.slug, f.owner, {
    name: "引用班级",
  });
  await setClassroomMember(f.other.slug, classroom.id, f.owner, f.student, 0, {
    role: "student",
  });
  const task = await createAssignment(f.other.slug, classroom.id, f.owner, {
    title: "副本作业",
    items: [{
      binding_id: imported.binding.id,
      requirement: "min_score",
      minimum_score: 6000,
    }],
  });
  await publishAssignment(f.other.slug, task.id, f.owner, 0, "publish");
  const submissionId = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.transaction(async (tx) => {
    await tx.insert(submissions).values({
      id: submissionId,
      domain_id: f.other.id,
      domain_problem_binding_id: imported.binding.id,
      user_id: f.student,
      problem_id: imported.binding.problem_id,
      language: "python",
      code: "学生原代码",
      submitted_version_id: imported.version_id,
      version_origin: "known",
      created_at: now,
    });
    await tx.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: submissionId,
      problem_id: imported.binding.problem_id,
      problem_version_id: imported.version_id,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      score: 7000,
      created_at: now,
    });
    await tx.insert(submissionVersionResults).values({
      id: crypto.randomUUID(),
      submission_id: submissionId,
      problem_id: imported.binding.problem_id,
      problem_version_id: imported.version_id,
      current_attempt_id: attemptId,
      updated_at: now,
    });
    await recomputeSubmissionProjection(tx, {
      kind: "submission",
      id: submissionId,
      problem_id: imported.binding.problem_id,
      domain_problem_binding_id: imported.binding.id,
      contest_id: null,
    });
  });
  assertEquals(
    (await getMyAssignmentProgress(f.other.slug, task.id, f.student)).cells[0]
      .score,
    7000,
  );
  const down = await setDomainProblemBindingState(
    f.other.slug,
    localRef,
    f.owner,
    0,
    { disabled: true, reason: "临时下架" },
  );
  assertEquals(down.revision, 1);
  assertEquals(
    (await resolveDomainProblem(f.school.slug, "1001", f.owner)).problem.id,
    f.problemId,
  );
  await assertRejects(
    () =>
      resolveDomainProblem(f.other.slug, localRef, f.student, {
        write: true,
      }),
    NotFoundError,
  );
  assertEquals(
    (await listDomainProblems(f.other.slug, f.student, { page: 1, limit: 50 }))
      .total,
    0,
  );
  for (
    let i = 0;
    i < 20 && (await processEducationBatch()).length;
    i++
  ) { /* 消费持久事件 */ }
  const unavailable = await getMyAssignmentProgress(
    f.other.slug,
    task.id,
    f.student,
  );
  assertEquals(unavailable.cells[0].status, "unavailable");
  assertEquals(unavailable.cells[0].score, 7000);
  const retained = await getClassroomStudentSubmission(
    f.other.slug,
    classroom.id,
    submissionId,
    "submission",
    f.owner,
  );
  assertEquals(retained.code, "学生原代码");
  assertEquals(retained.display_ref, localRef);
  assertEquals(
    (await f.db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    ))[0].code,
    "学生原代码",
  );
  await setDomainProblemBindingState(f.other.slug, localRef, f.owner, 1, {
    disabled: false,
    reason: "恢复副本",
  });
  assertEquals(
    (await getMyAssignmentProgress(f.other.slug, task.id, f.student)).cells[0]
      .status,
    "achieved",
  );
  assertEquals(
    (await f.db.select().from(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, imported.binding.id),
    )).map((h) => h.revision).sort(),
    [0, 1, 2],
  );
});

Deno.test("资源状态：错误域、普通成员、旧 revision 拒绝；目标域停用只影响本域且恢复不依赖来源共享", async () => {
  const f = await assignmentFixture();
  await assertRejects(
    () =>
      setDomainProblemBindingState(f.other.slug, "1001", f.owner, 0, {
        disabled: true,
        reason: "错误域",
      }),
    NotFoundError,
  );
  await assertRejects(
    () =>
      setDomainProblemBindingState(f.school.slug, "1001", f.student, 0, {
        disabled: true,
        reason: "越权",
      }),
    ForbiddenError,
  );
  await f.db.update(domains).set({
    configuration: { ...f.school.configuration, access: "public" },
  }).where(eq(domains.id, f.school.id));
  await setDomainProblemBindingState(f.school.slug, "1001", f.owner, 0, {
    disabled: false,
    visibility: "public",
    reason: "公开",
  });
  await assertRejects(
    () =>
      setDomainProblemBindingState(f.school.slug, "1001", f.owner, 0, {
        disabled: true,
        reason: "旧版本",
      }),
    ConflictError,
  );
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const imported = await importDomainProblem(
    f.other.slug,
    "class-school:1001",
    f.owner,
  );
  const localRef = imported.reference.display_ref;
  await setDomainProblemBindingState(
    f.other.slug,
    localRef,
    f.owner,
    0,
    { disabled: true, reason: "此学校停用引用" },
  );
  assertEquals(
    (await resolveDomainProblem(f.school.slug, "1001", f.student)).problem.id,
    f.problemId,
  );
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  const restored = await setDomainProblemBindingState(
    f.other.slug,
    localRef,
    f.owner,
    1,
    { disabled: false, reason: "重获授权" },
  );
  assertEquals(restored.id, imported.binding.id);
  assertEquals(restored.revision, 2);
});
