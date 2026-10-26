import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assignmentFeedback,
  queryProjectionRevisions,
  users,
} from "../../../../shared/db/schema.ts";
import { updateDomain } from "../../../workspace/index.ts";
import {
  createAssignment,
  createAssignmentFeedback,
  getAssignmentFeedback,
  getMyAssignmentProgress,
  listAssignmentFeedback,
  publishAssignment,
  removeClassroomMember,
  setClassroomMember,
  updateAssignmentFeedback,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "student" },
  );
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  return { ...f, task };
}

Deno.test("作业反馈：整体及个人范围、目标名单和跨域校验，学生不能看同学反馈", async () => {
  const f = await fixture();
  const common = await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "common",
    { body: "整体反馈" },
  );
  const first = await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "first",
    { body: "学生一反馈", target_user_id: f.student },
  );
  await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "second",
    { body: "学生二反馈", target_user_id: f.assistant },
  );
  assertEquals(
    (await listAssignmentFeedback(f.school.slug, f.task.id, f.student)).total,
    2,
  );
  assertEquals(
    (await listAssignmentFeedback(f.school.slug, f.task.id, f.assistant)).total,
    2,
  );
  assertEquals(
    (await listAssignmentFeedback(f.school.slug, f.task.id, f.teacher)).total,
    3,
  );
  assertEquals(
    (await getAssignmentFeedback(
      f.school.slug,
      f.task.id,
      common.id,
      f.student,
    )).body,
    "整体反馈",
  );
  await assertRejects(
    () =>
      getAssignmentFeedback(f.school.slug, f.task.id, first.id, f.assistant),
    NotFoundError,
  );
  await assertRejects(
    () => getAssignmentFeedback(f.other.slug, f.task.id, first.id, f.owner),
    NotFoundError,
  );
  await assertRejects(
    () =>
      createAssignmentFeedback(
        f.school.slug,
        f.task.id,
        f.student,
        "forbidden",
        { body: "越权" },
      ),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      createAssignmentFeedback(
        f.school.slug,
        f.task.id,
        f.teacher,
        "wrong-target",
        { body: "错误目标", target_user_id: f.teacher },
      ),
    NotFoundError,
  );
  assertEquals(
    await createAssignmentFeedback(
      f.school.slug,
      f.task.id,
      f.teacher,
      "first",
      { body: "学生一反馈", target_user_id: f.student },
    ),
    first,
  );
});

Deno.test("作业反馈：助教反馈能力独立，编辑需前置版本及原作者，撤回保留历史", async () => {
  const f = await fixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  const original = await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "original",
    { body: "教师反馈", target_user_id: f.student },
  );
  await assertRejects(
    () =>
      getAssignmentFeedback(f.school.slug, f.task.id, original.id, f.assistant),
    NotFoundError,
  );
  await assertRejects(
    () =>
      createAssignmentFeedback(f.school.slug, f.task.id, f.assistant, "write", {
        body: "越权",
      }),
    ForbiddenError,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    3,
    { role: "assistant", capabilities: ["feedback:write"] },
  );
  assertEquals(
    (await getAssignmentFeedback(
      f.school.slug,
      f.task.id,
      original.id,
      f.assistant,
    )).body,
    "教师反馈",
  );
  await assertRejects(
    () =>
      updateAssignmentFeedback(
        f.school.slug,
        f.task.id,
        original.id,
        f.assistant,
        0,
        { body: "改别人" },
      ),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      updateAssignmentFeedback(
        f.school.slug,
        f.task.id,
        original.id,
        f.teacher,
        null,
        { body: "缺版本" },
      ),
    AppError,
  );
  const edited = await updateAssignmentFeedback(
    f.school.slug,
    f.task.id,
    original.id,
    f.teacher,
    0,
    { body: "更新反馈" },
  );
  assertEquals(edited.revision, 1);
  await assertRejects(
    () =>
      updateAssignmentFeedback(
        f.school.slug,
        f.task.id,
        original.id,
        f.teacher,
        0,
        { body: "旧版本" },
      ),
    AppError,
  );
  await updateAssignmentFeedback(
    f.school.slug,
    f.task.id,
    original.id,
    f.teacher,
    1,
    { withdraw: true },
  );
  assertEquals(
    (await listAssignmentFeedback(f.school.slug, f.task.id, f.student)).total,
    0,
  );
  const [retained] = await f.db.select().from(assignmentFeedback).where(
    eq(assignmentFeedback.id, original.id),
  );
  assertEquals(retained.body, "更新反馈");
  assertEquals(retained.author_id, f.teacher);
});

Deno.test("作业反馈：离班及停用保持历史，作者注销有标识，反馈通知不使成绩口径失效", async () => {
  const f = await fixture();
  await getMyAssignmentProgress(f.school.slug, f.task.id, f.student);
  const before = (await f.db.select().from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, `education:domain:${f.school.id}`),
  ))[0].data_revision;
  const feedback = await createAssignmentFeedback(
    f.school.slug,
    f.task.id,
    f.teacher,
    "history",
    { body: "保留反馈", target_user_id: f.student },
  );
  const after = (await f.db.select().from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, `education:domain:${f.school.id}`),
  ))[0].data_revision;
  assertEquals(after, before);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    2,
  );
  assertEquals(
    (await getAssignmentFeedback(
      f.school.slug,
      f.task.id,
      feedback.id,
      f.student,
    )).body,
    "保留反馈",
  );
  await updateDomain(f.school.slug, f.owner, 0, {
    configuration: {
      ...f.school.configuration,
      features: {
        ...f.school.configuration.features,
        assignment: false,
        analytics: false,
      },
    },
  });
  await assertRejects(
    () =>
      createAssignmentFeedback(f.school.slug, f.task.id, f.teacher, "paused", {
        body: "停用写入",
      }),
    AppError,
  );
  await f.db.update(users).set({ deleted_at: new Date().toISOString() }).where(
    eq(users.id, f.teacher),
  );
  assertEquals(
    (await getAssignmentFeedback(
      f.school.slug,
      f.task.id,
      feedback.id,
      f.student,
    )).author_name,
    "已注销账号",
  );
});
