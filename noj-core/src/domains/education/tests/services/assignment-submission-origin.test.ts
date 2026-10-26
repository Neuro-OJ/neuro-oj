import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import {
  assignmentItems,
  assignmentRecipients,
  assignments,
  classroomMemberships,
  classrooms,
  domainMemberships,
  domains,
} from "../../../../shared/db/schema.ts";
import {
  createAssignment,
  publishAssignment,
  resolveAssignmentSubmissionOrigin,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture(publish = true) {
  const f = await assignmentFixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  if (publish) {
    await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "publish");
  }
  const [item] = await f.db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, draft.id),
  );
  const input = {
    domainId: f.school.id,
    actorId: f.student,
    bindingId: f.bindingId,
    problemId: f.problemId,
    origin: { assignment_id: draft.id, assignment_item_id: item.id },
  };
  return { ...f, assignmentId: draft.id, input };
}

Deno.test("作业受理来源：学生取得可信条目ID，截止与提前结束仍允许补做", async () => {
  const f = await fixture();
  const expected = f.input.origin;
  assertEquals(
    await f.db.transaction((tx) =>
      resolveAssignmentSubmissionOrigin(tx, f.input)
    ),
    expected,
  );
  await f.db.update(assignments).set({
    deadline_at: "2026-10-01T00:00:00.000Z",
    ended_at: "2026-10-01T00:00:00.000Z",
  }).where(eq(assignments.id, f.assignmentId));
  assertEquals(
    await f.db.transaction((tx) =>
      resolveAssignmentSubmissionOrigin(tx, f.input)
    ),
    expected,
  );
});

Deno.test("作业受理来源：错误域、题目、绑定、条目或无接收者的教练不能伪造来源", async () => {
  const f = await fixture();
  const otherAssignment = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    {
      title: "另一份同题作业",
      items: [{ binding_id: f.bindingId, requirement: "accepted" }],
    },
  );
  await publishAssignment(
    f.school.slug,
    otherAssignment.id,
    f.teacher,
    0,
    "publish-other",
  );
  const [otherItem] = await f.db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, otherAssignment.id),
  );
  for (
    const input of [
      { ...f.input, domainId: f.other.id },
      { ...f.input, problemId: crypto.randomUUID() },
      { ...f.input, bindingId: crypto.randomUUID() },
      { ...f.input, actorId: f.teacher },
      {
        ...f.input,
        // 条目真实存在、源题与绑定相同，但不能冒充属于另一份作业。
        origin: { ...f.input.origin, assignment_item_id: otherItem.id },
      },
      {
        ...f.input,
        origin: { ...f.input.origin, assignment_item_id: crypto.randomUUID() },
      },
    ]
  ) {
    await assertRejects(
      () =>
        f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, input)),
      NotFoundError,
    );
  }
});

Deno.test("作业受理来源：草稿不能成为学生正式提交的入口", async () => {
  const f = await fixture(false);
  await assertRejects(
    () =>
      f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, f.input)),
    NotFoundError,
  );
});

Deno.test("作业受理来源：当前域成员、班级学生和实际接收者关系逐次检查", async () => {
  const f = await fixture();
  await f.db.update(domainMemberships).set({ status: "removed" }).where(and(
    eq(domainMemberships.domain_id, f.school.id),
    eq(domainMemberships.user_id, f.student),
  ));
  await assertRejects(
    () =>
      f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, f.input)),
    NotFoundError,
  );
  await f.db.update(domainMemberships).set({ status: "active" }).where(and(
    eq(domainMemberships.domain_id, f.school.id),
    eq(domainMemberships.user_id, f.student),
  ));
  await f.db.update(classroomMemberships).set({ status: "removed" }).where(and(
    eq(classroomMemberships.classroom_id, f.classroom.id),
    eq(classroomMemberships.user_id, f.student),
  ));
  await assertRejects(
    () =>
      f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, f.input)),
    NotFoundError,
  );
  await f.db.update(classroomMemberships).set({ status: "active" }).where(and(
    eq(classroomMemberships.classroom_id, f.classroom.id),
    eq(classroomMemberships.user_id, f.student),
  ));
  await assertRejects(
    () =>
      f.db.transaction(async (tx) => {
        await tx.update(assignmentRecipients).set({ status: "historical" })
          .where(
            eq(assignmentRecipients.assignment_id, f.assignmentId),
          );
        // 同一事务刚撤销的接收关系必须立即生效，不能另取根连接读取旧状态。
        return await resolveAssignmentSubmissionOrigin(tx, f.input);
      }),
    NotFoundError,
  );
  assertEquals(
    await f.db.transaction((tx) =>
      resolveAssignmentSubmissionOrigin(tx, f.input)
    ),
    f.input.origin,
  );
});

Deno.test("作业受理来源：教学关闭不影响无来源练习，但带来源执行拒绝", async () => {
  const f = await fixture();
  await f.db.update(domains).set({
    configuration: {
      ...f.school.configuration,
      features: { ...f.school.configuration.features, assignment: false },
    },
  }).where(eq(domains.id, f.school.id));
  assertEquals(
    await f.db.transaction((tx) =>
      resolveAssignmentSubmissionOrigin(tx, { ...f.input, origin: undefined })
    ),
    { assignment_id: null, assignment_item_id: null },
  );
  const error = await assertRejects(
    () =>
      f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, f.input)),
    AppError,
  );
  assertEquals(error.code, "MODULE_DISABLED");
});

Deno.test("作业受理来源：作业和班级归档保留历史但停止带来源受理", async () => {
  const f = await fixture();
  await f.db.update(assignments).set({
    state: "archived",
    archived_at: new Date().toISOString(),
  }).where(eq(assignments.id, f.assignmentId));
  const assignmentError = await assertRejects(
    () =>
      f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, f.input)),
    AppError,
  );
  assertEquals(assignmentError.code, "ASSIGNMENT_READ_ONLY");
  await f.db.update(assignments).set({ state: "published", archived_at: null })
    .where(eq(assignments.id, f.assignmentId));
  await f.db.update(classrooms).set({
    status: "archived",
    archived_at: new Date().toISOString(),
  }).where(eq(classrooms.id, f.classroom.id));
  const classroomError = await assertRejects(
    () =>
      f.db.transaction((tx) => resolveAssignmentSubmissionOrigin(tx, f.input)),
    AppError,
  );
  assertEquals(classroomError.code, "CLASSROOM_READ_ONLY");
});
