import { setMemberRoles } from "../../../access/workspace/index.ts";
import { assertEquals, assertIsError, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  classroomContestLinks,
  classroomMemberships,
  classrooms,
  contests,
} from "../../../../shared/db/schema.ts";
import {
  assertClassroomCapability,
  createClassroom,
  getClassroom,
  listClassroomMembers,
  listClassrooms,
  loadClassroom,
  removeClassroomMember,
  setClassroomMember,
  updateClassroom,
} from "../../index.ts";
import {
  consumeDomainInvitation,
  createDomainInvitation,
  removeDomainMember,
} from "../../../access/workspace/index.ts";
import { educationFixture } from "../_fixtures.ts";
import { updateSetting } from "../../../platform/system/index.ts";

Deno.test("班级：同账号两域身份、错误域路径和学生只读自身成员记录", async () => {
  const f = await educationFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    0,
    { role: "student" },
  );
  const other = await createClassroom(f.other.slug, f.owner, {
    name: "同名一班",
  });
  await setClassroomMember(f.other.slug, other.id, f.owner, f.teacher, 0, {
    role: "student",
  });
  assertEquals(
    (await getClassroom(f.school.slug, f.classroom.id, f.teacher)).membership
      ?.role,
    undefined,
  );
  assertEquals(
    (await getClassroom(f.other.slug, other.id, f.teacher)).membership?.role,
    "student",
  );
  await assertRejects(
    () => getClassroom(f.school.slug, other.id, f.teacher),
    NotFoundError,
  );
  await assertRejects(
    () =>
      updateClassroom(f.other.slug, other.id, f.teacher, 1, { name: "越权" }),
    ForbiddenError,
  );
  assertEquals(
    (await listClassroomMembers(f.school.slug, f.classroom.id, f.student))
      .length,
    1,
  );
  assertEquals((await listClassrooms(f.school.slug, f.assistant)).length, 0);
});

Deno.test("教练：域级授权覆盖他人班级，撤权即时生效且不能任命教学人员", async () => {
  const f = await educationFixture();
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["educator"]);
  const access = await loadClassroom(
    f.school.slug,
    f.classroom.id,
    f.assistant,
  );
  assertClassroomCapability(access, "progress:read");
  assertClassroomCapability(access, "submissions:read");
  assertEquals(access.classMembership, null);
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.assistant,
    f.student,
    0,
    { role: "student" },
  );
  await assertRejects(
    () => setMemberRoles(f.school.slug, f.assistant, f.student, ["educator"]),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      setClassroomMember(
        f.school.slug,
        f.classroom.id,
        f.assistant,
        f.student,
        1,
        { role: "coach" as never },
      ),
    BadRequestError,
  );
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["member"]);
  await assertRejects(
    () => loadClassroom(f.school.slug, f.classroom.id, f.assistant),
    NotFoundError,
  );
});

Deno.test("班级：教师撤职、学生离班保留历史并撤销当前访问", async () => {
  const f = await educationFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    0,
    { role: "student" },
  );
  await setMemberRoles(f.school.slug, f.owner, f.teacher, ["member"]);
  await assertRejects(
    () => getClassroom(f.school.slug, f.classroom.id, f.teacher),
    NotFoundError,
  );
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.owner,
    f.student,
    1,
  );
  const [stored] = await f.db.select().from(classroomMemberships).where(
    eq(classroomMemberships.user_id, f.student),
  );
  assertEquals(stored.status, "removed");
  assertEquals(
    (await f.db.select().from(classrooms).where(
      eq(classrooms.id, f.classroom.id),
    ))[0].id,
    f.classroom.id,
  );
});

Deno.test("班级：revision、只读归档、关闭教学后仍能读取授权历史", async () => {
  const f = await educationFixture();
  await assertRejects(
    () =>
      updateClassroom(f.school.slug, f.classroom.id, f.teacher, null, {
        name: "修改",
      }),
    AppError,
  );
  await updateClassroom(f.school.slug, f.classroom.id, f.teacher, 0, {
    name: "修改",
  });
  const stale = await assertRejects(
    () =>
      updateClassroom(f.school.slug, f.classroom.id, f.teacher, 0, {
        name: "旧值",
      }),
    AppError,
  );
  assertEquals(stale.statusCode, 409);
  const archived = await updateClassroom(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    1,
    { archive: true },
  );
  assertEquals(archived.status, "archived");
  await assertRejects(
    () =>
      setClassroomMember(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        f.student,
        2,
        { role: "student" },
      ),
    AppError,
  );
  assertEquals(
    (await getClassroom(f.school.slug, f.classroom.id, f.teacher)).name,
    "修改",
  );
  await updateSetting(
    "instance_allowed_modules",
    JSON.stringify({
      community: true,
      classroom: false,
      assignment: false,
      analytics: true,
    }),
    "0",
  );
  assertEquals(
    (await getClassroom(f.school.slug, f.classroom.id, f.teacher)).status,
    "archived",
  );
  await assertRejects(
    () => createClassroom(f.school.slug, f.teacher, { name: "不能创建" }),
    AppError,
  );
});

Deno.test("班级约束：跨域成员和跨域比赛不能关联", async () => {
  const f = await educationFixture(), now = new Date().toISOString();
  const memberError = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.insert(classroomMemberships).values({
        id: crypto.randomUUID(),
        domain_id: f.other.id,
        classroom_id: f.classroom.id,
        user_id: f.student,
        role: "student",
        joined_at: now,
        appointed_at: now,
      })
    )
  );
  assertIsError(memberError);
  assertEquals((memberError.cause as { code: string }).code, "23503");
  const id = crypto.randomUUID();
  await f.db.insert(contests).values({
    id,
    domain_id: f.other.id,
    title: "另一学校的比赛",
    type: "ioi",
    start_time: now,
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  const linkError = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.insert(classroomContestLinks).values({
        domain_id: f.school.id,
        classroom_id: f.classroom.id,
        contest_id: id,
        linked_by: f.teacher,
        linked_at: now,
      })
    )
  );
  assertIsError(linkError);
  assertEquals((linkError.cause as { code: string }).code, "23503");
  await assertRejects(
    () =>
      setClassroomMember(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        f.student,
        0,
        {
          role: "assistant" as never,
          capabilities: ["domain:settings"] as never,
        },
      ),
    BadRequestError,
  );
});

Deno.test("教学撤权：重新入域不恢复旧的域教练权限", async () => {
  const f = await educationFixture();
  await setMemberRoles(f.school.slug, f.owner, f.assistant, ["educator"]);
  await removeDomainMember(f.school.slug, f.owner, f.assistant);
  const invite = await createDomainInvitation(
    f.school.slug,
    f.owner,
    `${f.assistant}@example.com`,
  );
  await consumeDomainInvitation(invite.token, f.assistant);
  await assertRejects(
    () => loadClassroom(f.school.slug, f.classroom.id, f.assistant),
    NotFoundError,
  );
  const [stored] = await f.db.select().from(classroomMemberships).where(
    eq(classroomMemberships.user_id, f.assistant),
  );
  assertEquals(stored, undefined);
});
