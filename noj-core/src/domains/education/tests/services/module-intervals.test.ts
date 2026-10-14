import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  createAssignment,
  getMyAssignmentProgress,
  publishAssignment,
} from "../../index.ts";
import { updateDomain } from "../../../workspace/index.ts";
import { resetSetting, updateSetting } from "../../../system/index.ts";
import {
  educationDisabledIntervals,
  evaluationAttempts,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  return { ...f, task };
}
async function practice(f: Awaited<ReturnType<typeof fixture>>) {
  const id = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(submissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python",
    code: "practice",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: now,
  });
  await f.db.insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: id,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    score: 10000,
    created_at: now,
  });
  await f.db.insert(submissionVersionResults).values({
    id: crypto.randomUUID(),
    submission_id: id,
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    current_attempt_id: attemptId,
    updated_at: now,
  });
}

Deno.test("教学停用：域区间排除正常练习，保留任务读取，重新启用不自动回填", async () => {
  const f = await fixture();
  const disabled = await updateDomain(
    f.school.slug,
    f.owner,
    f.school.revision,
    {
      configuration: {
        ...f.school.configuration,
        features: {
          ...f.school.configuration.features,
          assignment: false,
          analytics: false,
        },
      },
    },
  );
  await practice(f);
  await assertRejects(
    () => createAssignment(f.school.slug, f.classroom.id, f.teacher, f.input),
    AppError,
  );
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    null,
  );
  await updateDomain(f.school.slug, f.owner, disabled.revision, {
    configuration: f.school.configuration,
  });
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    null,
  );
});

Deno.test("教学停用：实例区间与政策原子保存，重置政策恢复时仍排除停用练习", async () => {
  const f = await fixture();
  await updateSetting(
    "instance_allowed_modules",
    JSON.stringify({
      community: true,
      classroom: true,
      assignment: false,
      analytics: false,
    }),
    "0",
  );
  await practice(f);
  await assertRejects(
    () => createAssignment(f.school.slug, f.classroom.id, f.teacher, f.input),
    AppError,
  );
  const [interval] = await f.db.select().from(educationDisabledIntervals);
  assertEquals(interval.domain_id, null);
  assertEquals(interval.ended_at, null);
  await resetSetting("instance_allowed_modules", "0");
  assertEquals(
    (await f.db.select().from(educationDisabledIntervals))[0].ended_at !== null,
    true,
  );
  assertEquals(
    (await getMyAssignmentProgress(f.school.slug, f.task.id, f.student))
      .cells[0].score,
    null,
  );
});
