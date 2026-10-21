import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assignmentItemHistory,
  assignmentItems,
  assignmentRecipients,
  assignments,
  domainProblemBindings,
  educationOutbox,
} from "../../../../shared/db/schema.ts";
import {
  changeAssignmentLifecycle,
  copyAssignment,
  createAssignment,
  getAssignment,
  listAssignments,
  publishAssignment,
  publishDueAssignments,
  removeClassroomMember,
  scheduleAssignment,
  setClassroomMember,
  updateAssignment,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";
import { loadClassroom } from "../../services/access.ts";
import { insertAssignmentDraft } from "../../services/assignments.ts";

Deno.test("作业事务上下文：复用授权后仍逐题检查当前绑定，失效不留下半份草稿", async () => {
  const f = await assignmentFixture();
  await assertRejects(() =>
    f.db.transaction(async (tx) => {
      const access = await loadClassroom(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        { executor: tx, write: true },
      );
      await tx.update(domainProblemBindings).set({
        disabled_at: new Date().toISOString(),
      })
        .where(eq(domainProblemBindings.id, f.bindingId));
      return await insertAssignmentDraft(tx, access, f.input);
    }), NotFoundError);
  assertEquals((await f.db.select().from(assignments)).length, 0);
  const created = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  assertEquals(created.classroom_id, f.classroom.id);
});

Deno.test("教学类型能力：旧导航与模块开关不覆盖固定类型，原任务继续可读", async () => {
  const f = await assignmentFixture();
  await f.db.execute(
    sql`UPDATE domains SET configuration = jsonb_set(configuration, '{homepage}', '"unknown-navigation"') WHERE id = ${f.school.id}`,
  );
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  assertEquals(draft.state, "draft");
  await f.db.execute(
    sql`UPDATE domains SET configuration = jsonb_set(configuration, '{features,assignment}', '"enabled"') WHERE id = ${f.school.id}`,
  );
  await createAssignment(f.school.slug, f.classroom.id, f.teacher, f.input);
  assertEquals(
    (await getAssignment(f.school.slug, draft.id, f.teacher)).id,
    draft.id,
  );
  assertEquals((await f.db.select().from(assignments)).length, 2);
});

Deno.test("作业：发布固定条目与名单、原子保存版本依据和事件，重复键不重复发布", async () => {
  const f = await assignmentFixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await assertRejects(
    () => getAssignment(f.school.slug, draft.id, f.student),
    NotFoundError,
  );
  assertEquals(
    await listAssignments(f.school.slug, f.classroom.id, f.student),
    [],
  );
  const published = await publishAssignment(
    f.school.slug,
    draft.id,
    f.teacher,
    0,
    "publish-one",
  );
  assertEquals(published.state, "published");
  assertEquals(
    await publishAssignment(
      f.school.slug,
      draft.id,
      f.teacher,
      0,
      "publish-one",
    ),
    published,
  );
  assertEquals(
    (await f.db.select().from(assignmentRecipients)).map((r) => r.user_id),
    [f.student],
  );
  const [item] = await f.db.select().from(assignmentItems);
  assertEquals(item.minimum_score, 6000);
  assertEquals(item.published_version_id, f.versionId);
  assertEquals(item.answer_version_id, f.versionId);
  assertEquals((await f.db.select().from(assignmentItemHistory)).length, 1);
  assertEquals((await f.db.select().from(educationOutbox)).length, 2);
  const detail = await getAssignment(f.school.slug, draft.id, f.student);
  assertEquals("target_student_ids" in detail, false);
  await assertRejects(
    () => updateAssignment(f.school.slug, draft.id, f.teacher, 1, f.input),
    ConflictError,
  );
  await assertRejects(
    () =>
      publishAssignment(f.school.slug, draft.id, f.teacher, 1, "publish-one"),
    ConflictError,
  );
});

Deno.test("作业：题库绑定、目标名单与写权限严格限定当前班级和域", async () => {
  const f = await assignmentFixture();
  await assertRejects(
    () => createAssignment(f.other.slug, f.classroom.id, f.owner, f.input),
    NotFoundError,
  );
  await assertRejects(
    () => createAssignment(f.school.slug, f.classroom.id, f.student, f.input),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      createAssignment(f.school.slug, f.classroom.id, f.teacher, {
        ...f.input,
        target_student_ids: [f.teacher],
      }),
    BadRequestError,
  );
  await assertRejects(
    () =>
      createAssignment(f.school.slug, f.classroom.id, f.teacher, {
        ...f.input,
        items: [{
          binding_id: f.bindingId,
          requirement: "min_score",
          minimum_score: null,
        }],
      }),
    BadRequestError,
  );
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    {
      ...f.input,
      target_student_ids: [f.student],
      include_previous_submissions: true,
    },
  );
  await assertRejects(
    () => updateAssignment(f.school.slug, draft.id, f.teacher, null, f.input),
    AppError,
  );
  const edited = await updateAssignment(f.school.slug, draft.id, f.teacher, 0, {
    ...f.input,
    title: "新题目集合",
  });
  assertEquals(edited.revision, 1);
  await assertRejects(
    () => getAssignment(f.other.slug, draft.id, f.owner),
    NotFoundError,
  );
  await assertRejects(
    () => updateAssignment(f.school.slug, draft.id, f.teacher, 0, f.input),
    AppError,
  );
});

Deno.test("作业：发布时资源失效整体回滚；定时发布再次校验并保留具体失败", async () => {
  const f = await assignmentFixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const scheduled = await scheduleAssignment(
    f.school.slug,
    draft.id,
    f.teacher,
    0,
    new Date(Date.now() + 60000).toISOString(),
  );
  await assertRejects(
    () =>
      publishAssignment(
        f.school.slug,
        draft.id,
        f.teacher,
        scheduled.revision,
        "early",
      ),
    ConflictError,
  );
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  await f.db.update(assignments).set({
    publish_at: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(assignments.id, draft.id));
  assertEquals(await publishDueAssignments(), [{
    id: draft.id,
    published: false,
  }]);
  const failed = await getAssignment(f.school.slug, draft.id, f.teacher);
  assertEquals(failed.state, "draft");
  assertEquals(failed.published_at, null);
  assertEquals(typeof failed.publish_error, "string");
  assertEquals((await f.db.select().from(assignmentRecipients)).length, 0);
  assertEquals((await f.db.select().from(assignmentItemHistory)).length, 0);
  assertEquals((await f.db.select().from(educationOutbox)).length, 0);
  assertEquals(failed.items[0].published_version_id, null);
});

Deno.test("作业：按当前有效策略发布，延长截止有沿革，归档保留学生阅读", async () => {
  const f = await assignmentFixture();
  await f.db.update(domainProblemBindings).set({
    effective_version_mode: "exact",
    required_version_id: f.versionId,
    revision: 2,
  }).where(eq(domainProblemBindings.id, f.bindingId));
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    { ...f.input, deadline_at: deadline },
  );
  await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "exact");
  const detail = await getAssignment(f.school.slug, draft.id, f.student);
  assertEquals(detail.items[0].published_policy_mode, "exact");
  assertEquals(detail.items[0].published_policy_revision, 2);
  await assertRejects(
    () =>
      changeAssignmentLifecycle(f.school.slug, draft.id, f.teacher, 1, {
        action: "extend",
        reason: "缩短",
        deadline_at: new Date(Date.now() + 1000).toISOString(),
      }),
    BadRequestError,
  );
  const extended = await changeAssignmentLifecycle(
    f.school.slug,
    draft.id,
    f.teacher,
    1,
    {
      action: "extend",
      reason: "延长练习",
      deadline_at: new Date(Date.now() + 7200000).toISOString(),
    },
  );
  assertEquals(extended.revision, 2);
  const archived = await changeAssignmentLifecycle(
    f.school.slug,
    draft.id,
    f.teacher,
    2,
    { action: "archive", reason: "学期结束" },
  );
  assertEquals(archived.state, "archived");
  assertEquals(
    (await getAssignment(f.school.slug, draft.id, f.student)).state,
    "archived",
  );
  assertEquals((await f.db.select().from(assignmentRecipients)).length, 1);
});

Deno.test("作业名单：新生只补入未截止全班任务，离班保留历史并结束计入区间", async () => {
  const f = await assignmentFixture();
  const all = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const selected = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    { ...f.input, target_student_ids: [f.student] },
  );
  const closed = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  for (const task of [all, selected, closed]) {
    await publishAssignment(f.school.slug, task.id, f.teacher, 0, task.id);
  }
  await f.db.update(assignments).set({
    deadline_at: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(assignments.id, closed.id));
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "student" },
  );
  const newcomer = await f.db.select().from(assignmentRecipients).where(
    eq(assignmentRecipients.user_id, f.assistant),
  );
  assertEquals(newcomer.map((r) => r.assignment_id), [all.id]);
  assertEquals(newcomer[0].added_by, "automatic");
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    2,
  );
  const historical = await f.db.select().from(assignmentRecipients).where(
    eq(assignmentRecipients.user_id, f.student),
  );
  assertEquals(
    historical.every((r) =>
      r.status === "historical" && !!r.left_at && !!r.credit_intervals[0].end
    ),
    true,
  );
  assertEquals(
    (await getAssignment(f.school.slug, selected.id, f.student)).id,
    selected.id,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    3,
    { role: "student" },
  );
  const restored = await f.db.select().from(assignmentRecipients).where(
    eq(assignmentRecipients.user_id, f.student),
  );
  assertEquals(
    restored.find((r) => r.assignment_id === all.id)?.credit_intervals.length,
    2,
  );
  assertEquals(
    restored.find((r) => r.assignment_id === selected.id)?.status,
    "active",
  );
  assertEquals(
    restored.find((r) => r.assignment_id === closed.id)?.status,
    "active",
  );
});

Deno.test("作业复制：生成独立部分学生补题，保留来源且重试不重复创建", async () => {
  const f = await assignmentFixture();
  const original = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const published = await publishAssignment(
    f.school.slug,
    original.id,
    f.teacher,
    0,
    "original",
  );
  const detail = await getAssignment(f.school.slug, original.id, f.teacher);
  const input = {
    title: "单独补题",
    item_ids: [detail.items[0].id],
    target_student_ids: [f.student],
  };
  const copied = await copyAssignment(
    f.school.slug,
    original.id,
    f.teacher,
    1,
    "copy",
    input,
  );
  assertEquals(copied.state, "draft");
  assertEquals(copied.source_assignment_id, original.id);
  assertEquals(copied.include_previous_submissions, false);
  assertEquals(
    await copyAssignment(
      f.school.slug,
      original.id,
      f.teacher,
      1,
      "copy",
      input,
    ),
    copied,
  );
  assertEquals((await f.db.select().from(assignments)).length, 2);
  const copiedDetail = await getAssignment(f.school.slug, copied.id, f.teacher);
  assertEquals(copiedDetail.items[0].published_version_id, null);
  assertEquals(copiedDetail.items[0].minimum_score, 6000);
  await assertRejects(
    () =>
      copyAssignment(f.school.slug, original.id, f.student, 1, "copy", input),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      copyAssignment(f.school.slug, original.id, f.teacher, 1, "invalid", {
        item_ids: [crypto.randomUUID()],
      }),
    BadRequestError,
  );
  await publishAssignment(
    f.school.slug,
    copied.id,
    f.teacher,
    0,
    "remediation",
  );
  assertEquals((await f.db.select().from(assignmentRecipients)).length, 2);
  assertEquals(
    (await getAssignment(f.school.slug, original.id, f.teacher)).revision,
    published.revision,
  );
});
