import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { recomputeSubmissionProjection } from "../../../submission/index.ts";
import { eq } from "drizzle-orm";
import {
  assignmentProgress,
  educationOutbox,
  evaluationAttempts,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  createAssignment,
  publishAssignment,
  startEducationWorker,
} from "../../index.ts";
import {
  claimEducationEvents,
  processEducationBatch,
  processEducationEvent,
} from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

/** 使用真实提交投影入口写正式成绩及同事务教学事件。 */
async function gradeFixture(f: Awaited<ReturnType<typeof assignmentFixture>>) {
  const sourceId = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.transaction(async (tx) => {
    await tx.insert(submissions).values({
      id: sourceId,
      domain_id: f.school.id,
      domain_problem_binding_id: f.bindingId,
      user_id: f.student,
      problem_id: f.problemId,
      language: "python",
      code: "print(1)",
      submitted_version_id: f.versionId,
      version_origin: "known",
      created_at: now,
    });
    await tx.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: sourceId,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      score: 6500,
      created_at: now,
    });
    await tx.insert(submissionVersionResults).values({
      id: crypto.randomUUID(),
      submission_id: sourceId,
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      current_attempt_id: attemptId,
      updated_at: now,
    });
    await recomputeSubmissionProjection(tx, {
      kind: "submission",
      id: sourceId,
      problem_id: f.problemId,
      contest_id: null,
      domain_problem_binding_id: f.bindingId,
    });
  });
  return sourceId;
}

Deno.test("教学评测事件：正式判定事务产生事件，消费者自动读取成绩，失败事务不留事件", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const sourceId = await gradeFixture(f);
  const events = await f.db.select().from(educationOutbox);
  assertEquals(
    events.filter((e) => e.event_type === "submission.changed").length,
    1,
  );
  await assertRejects(
    () =>
      f.db.transaction(async (tx) => {
        await recomputeSubmissionProjection(tx, {
          kind: "submission",
          id: sourceId,
          problem_id: f.problemId,
          contest_id: null,
          domain_problem_binding_id: f.bindingId,
        });
        throw new Error("测试业务事务回滚");
      }),
    Error,
    "测试业务事务回滚",
  );
  assertEquals(
    (await f.db.select().from(educationOutbox)).length,
    events.length,
  );
  await processEducationBatch();
  const cells = await f.db.select().from(assignmentProgress);
  assertEquals(cells.length, 2);
  assertEquals(
    cells.every((c) => c.score === 6500 && c.status === "achieved"),
    true,
  );
});

Deno.test("教学事件：重复与乱序按最新事实覆盖，持久游标在下一次领取继续", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const [event] = await claimEducationEvents();
  assertEquals(await processEducationEvent(event), true);
  assertEquals((await f.db.select().from(assignmentProgress)).length, 2);
  const [checkpoint] = await f.db.select().from(educationOutbox);
  assertEquals(checkpoint.processed_at, null);
  assertEquals(checkpoint.lease_token, null);
  assertEquals(checkpoint.payload._education_cursor, {
    assignment_after: task.id,
  });
  await processEducationBatch();
  assertEquals(
    (await f.db.select().from(educationOutbox))[0].processed_at !== null,
    true,
  );
  assertEquals((await claimEducationEvents()).length, 0);
  assertEquals(await processEducationEvent(event), false);
});

Deno.test("教学事件：并发领取不重复，过期租约回收，旧租约不能提交游标", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const groups = await Promise.all([
    claimEducationEvents(1),
    claimEducationEvents(1),
  ]);
  assertEquals(groups[0].length + groups[1].length, 1);
  const old = groups.flat()[0];
  await f.db.update(educationOutbox).set({
    leased_until: "2020-01-01T00:00:00.000Z",
  }).where(eq(educationOutbox.id, old.id));
  const [fresh] = await claimEducationEvents();
  assertEquals(fresh.id, old.id);
  assertEquals(fresh.lease_token !== old.lease_token, true);
  assertEquals(await processEducationEvent(old), false);
  assertEquals(await processEducationEvent(fresh), true);
  await processEducationBatch();
  assertEquals((await f.db.select().from(assignmentProgress)).length, 2);
});

Deno.test("教学自动更新：后台循环消费正式成绩，完成后停止不遗留计时器", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  await gradeFixture(f);
  const started = Date.now(), worker = startEducationWorker();
  try {
    let cells = await f.db.select().from(assignmentProgress);
    while (cells.length !== 2 && Date.now() - started < 5000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      cells = await f.db.select().from(assignmentProgress);
    }
    assertEquals(cells.length, 2);
    assertEquals(
      cells.every((c) => c.score === 6500 && c.status === "achieved"),
      true,
    );
    assertEquals(Date.now() - started < 5000, true);
  } finally {
    worker.stop();
    await worker.done;
  }
});
