import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createAssignment,
  getAssignment,
  getClassroom,
  listClassroomMembers,
  publishAssignment,
  removeClassroomMember,
  setClassroomMember,
  transferClassroom,
} from "../../index.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教学管理读取：作业助教可选择学生，只有成员管理者读取他人助教授权", async () => {
  const f = await assignmentFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "assistant", capabilities: ["assignments:manage"] },
  );
  const roster = await listClassroomMembers(
    f.school.slug,
    f.classroom.id,
    f.assistant,
  );
  assertEquals(roster.some((m) => m.user_id === f.student), true);
  assertEquals(roster.every((m) => !("capabilities" in m)), true);
  const managerRoster = await listClassroomMembers(
    f.school.slug,
    f.classroom.id,
    f.teacher,
  );
  assertEquals(
    managerRoster.find((m) => m.user_id === f.assistant)?.capabilities,
    ["assignments:manage"],
  );
  assertEquals(
    (await listClassroomMembers(f.school.slug, f.classroom.id, f.student)).map(
      (m) => m.user_id,
    ),
    [f.student],
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["feedback:write"] },
  );
  assertEquals(
    (await listClassroomMembers(f.school.slug, f.classroom.id, f.assistant))
      .map((m) => m.user_id),
    [f.assistant],
  );
});

Deno.test("教学管理读取：离班学生可读取历史班级但没有当前身份，离职教师仍不可访问", async () => {
  const f = await assignmentFixture();
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    1,
  );
  const room = await getClassroom(f.school.slug, f.classroom.id, f.student);
  assertEquals(room.membership, null);
  assertEquals(room.historical_student, true);
  assertEquals(room.capabilities, []);
  assertEquals(room.manages_domain, false);
  await setClassroomMember(f.school.slug, f.classroom.id, f.owner, f.owner, 2, {
    role: "coach",
  });
  await transferClassroom(f.school.slug, f.classroom.id, f.owner, f.owner, 3);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.owner,
    f.teacher,
    4,
  );
  await assertRejects(
    () => getClassroom(f.school.slug, f.classroom.id, f.teacher),
    NotFoundError,
  );
  await assertRejects(
    () => getClassroom(f.other.slug, f.classroom.id, f.student),
    NotFoundError,
  );
});

Deno.test("教学管理读取：仅提交读取的助教可选择学生但不能取得其他助教授权", async () => {
  const f = await assignmentFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    {
      role: "assistant",
      capabilities: ["submissions:read"],
    },
  );
  const roster = await listClassroomMembers(
    f.school.slug,
    f.classroom.id,
    f.assistant,
  );
  assertEquals(roster.some((member) => member.user_id === f.student), true);
  assertEquals(roster.every((member) => !("capabilities" in member)), true);
  const room = await getClassroom(f.school.slug, f.classroom.id, f.assistant);
  assertEquals(room.capabilities, ["submissions:read"]);
});

Deno.test("作业管理读取：来源题号及发布依据可读，学生 DTO 不附带其他目标学生或源题内容", async () => {
  const f = await assignmentFixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  const preview = await getAssignment(f.school.slug, draft.id, f.teacher);
  assertEquals(preview.items[0].reference.display_ref, "1001");
  assertEquals(
    preview.items[0].reference.qualified_ref,
    `${f.school.slug}:1001`,
  );
  await assertRejects(
    () => getAssignment(f.school.slug, draft.id, f.student),
    NotFoundError,
  );
  await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "publish");
  const own = await getAssignment(f.school.slug, draft.id, f.student);
  assertEquals(own.items[0].reference.display_ref, "1001");
  assertEquals("target_student_ids" in own, false);
  assertEquals("content" in own.items[0], false);
  assertEquals("problem" in own.items[0], false);
});
