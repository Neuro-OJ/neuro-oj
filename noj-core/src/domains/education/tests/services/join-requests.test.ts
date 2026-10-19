import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  domainMemberships,
  users,
} from "../../../../shared/db/schema.ts";
import {
  getClassroom,
  listClassroomJoinRequests,
  readClassroomJoin,
  requestClassroomJoin,
  reviewClassroomJoin,
  setClassroomMember,
} from "../../index.ts";
import { educationFixture } from "../_fixtures.ts";
import { setMemberRole } from "../../../workspace/index.ts";

Deno.test("班级申请：链接只展示本人记录，重复申请不重复写入，审核原子加入学生且幂等", async () => {
  const f = await educationFixture();
  await assertRejects(
    () => getClassroom(f.school.slug, f.classroom.id, f.student),
    NotFoundError,
  );
  const preview = await readClassroomJoin(
    f.school.slug,
    f.classroom.id,
    f.student,
  );
  assertEquals(preview.can_apply, true);
  assertEquals("members" in preview, false);
  const request = await requestClassroomJoin(
    f.school.slug,
    f.classroom.id,
    f.student,
    "想加入训练",
  );
  assertEquals(
    (await requestClassroomJoin(
      f.school.slug,
      f.classroom.id,
      f.student,
      "重复",
    )).id,
    request.id,
  );
  assertEquals(
    (await readClassroomJoin(f.school.slug, f.classroom.id, f.assistant))
      .request,
    null,
  );
  await assertRejects(
    () =>
      reviewClassroomJoin(
        f.school.slug,
        f.classroom.id,
        request.id,
        f.teacher,
        null,
        "missing",
        "approve",
      ),
    AppError,
  );
  const approved = await reviewClassroomJoin(
    f.school.slug,
    f.classroom.id,
    request.id,
    f.teacher,
    0,
    "review",
    "approve",
  );
  assertEquals(approved.status, "approved");
  assertEquals(
    (await reviewClassroomJoin(
      f.school.slug,
      f.classroom.id,
      request.id,
      f.teacher,
      0,
      "review",
      "approve",
    )).id,
    request.id,
  );
  const members = await f.db.select().from(classroomMemberships).where(
    eq(classroomMemberships.user_id, f.student),
  );
  assertEquals(members[0].role, "student");
  assertEquals(
    (await readClassroomJoin(f.school.slug, f.classroom.id, f.student))
      .can_apply,
    false,
  );
  await assertRejects(
    () => listClassroomJoinRequests(f.school.slug, f.classroom.id, f.student),
    ForbiddenError,
  );
});

Deno.test("班级申请：错误域拒绝，域成员退出后不能批准，已注销申请保留并可拒绝", async () => {
  const f = await educationFixture();
  const request = await requestClassroomJoin(
    f.school.slug,
    f.classroom.id,
    f.student,
    "申请",
  );
  await assertRejects(
    () => readClassroomJoin(f.other.slug, f.classroom.id, f.student),
    NotFoundError,
  );
  await assertRejects(
    () =>
      reviewClassroomJoin(
        f.other.slug,
        f.classroom.id,
        request.id,
        f.owner,
        0,
        "wrong",
        "approve",
      ),
    NotFoundError,
  );
  await f.db.update(domainMemberships).set({ status: "removed" }).where(
    eq(domainMemberships.user_id, f.student),
  );
  await assertRejects(
    () =>
      reviewClassroomJoin(
        f.school.slug,
        f.classroom.id,
        request.id,
        f.teacher,
        0,
        "left",
        "approve",
      ),
    NotFoundError,
  );
  await f.db.update(users).set({ deleted_at: new Date().toISOString() }).where(
    eq(users.id, f.student),
  );
  assertEquals(
    (await listClassroomJoinRequests(f.school.slug, f.classroom.id, f.teacher))
      .data[0].username,
    "已注销账号",
  );
  assertEquals(
    (await reviewClassroomJoin(
      f.school.slug,
      f.classroom.id,
      request.id,
      f.teacher,
      0,
      "reject",
      "reject",
    )).status,
    "rejected",
  );
});

Deno.test("班级申请：普通班级学生不可审核，域负责人任命教练后可以审核", async () => {
  const f = await educationFixture();
  const request = await requestClassroomJoin(
    f.school.slug,
    f.classroom.id,
    f.student,
    "申请",
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    0,
    {},
  );
  await assertRejects(
    () =>
      reviewClassroomJoin(
        f.school.slug,
        f.classroom.id,
        request.id,
        f.assistant,
        1,
        "feedback",
        "approve",
      ),
    ForbiddenError,
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  assertEquals(
    (await reviewClassroomJoin(
      f.school.slug,
      f.classroom.id,
      request.id,
      f.assistant,
      1,
      "granted",
      "approve",
    )).status,
    "approved",
  );
});
