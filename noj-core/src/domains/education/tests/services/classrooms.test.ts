import {
  assertEquals,
  assertIsError,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1";
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
  setClassroomMember,
  transferClassroom,
  updateClassroom,
} from "../../index.ts";
import {
  consumeDomainInvitation,
  createDomainInvitation,
  removeDomainMember,
  setMemberRole,
} from "../../../workspace/index.ts";
import { educationFixture } from "../_fixtures.ts";
import { updateSetting } from "../../../system/index.ts";

Deno.test("班级：同账号两域身份、错误域路径和学生只读自身成员记录", async () => {
  const f = await educationFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    0,
    {},
  );
  const other = await createClassroom(f.other.slug, f.owner, {
    name: "同名一班",
  });
  await setClassroomMember(f.other.slug, other.id, f.owner, f.teacher, 0, {});
  assertEquals(
    (await getClassroom(f.school.slug, f.classroom.id, f.teacher)).manages_domain,
    true,
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

Deno.test("班级任职：不能自行授权或任命教练，现任域教练具有所有教学能力", async () => {
  const f = await educationFixture();
  await setClassroomMember(f.school.slug, f.classroom.id, f.teacher, f.assistant, 0, {});
  const member = await loadClassroom(f.school.slug, f.classroom.id, f.assistant);
  for (const capability of ["progress:read", "submissions:read", "students:manage"] as const) {
    assertThrows(() => assertClassroomCapability(member, capability), ForbiddenError);
  }
  await assertRejects(() => setMemberRole(f.school.slug, f.assistant, f.assistant, "coach"), ForbiddenError);
  await assertRejects(() => setClassroomMember(f.school.slug, f.classroom.id, f.teacher, f.assistant, 1, { role: "coach" }), BadRequestError);
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  const teacher = await loadClassroom(f.school.slug, f.classroom.id, f.assistant);
  for (const capability of ["progress:read", "submissions:read", "students:manage"] as const) {
    assertClassroomCapability(teacher, capability);
  }
  await setClassroomMember(f.school.slug, f.classroom.id, f.assistant, f.student, 1, {});
  await setMemberRole(f.school.slug, f.owner, f.assistant, "member");
  const downgraded = await loadClassroom(f.school.slug, f.classroom.id, f.assistant);
  assertThrows(() => assertClassroomCapability(downgraded, "progress:read"), ForbiddenError);
});

Deno.test("班级联系人：交接不授予教练权限，域教练降级立即失权且保留学生历史", async () => {
  const f = await educationFixture();
  await setClassroomMember(f.school.slug, f.classroom.id, f.teacher, f.student, 0, {});
  const transferred = await transferClassroom(f.school.slug, f.classroom.id, f.teacher, f.student, 1);
  assertEquals(transferred.primary_coach_id, f.student);
  assertEquals((await getClassroom(f.school.slug, f.classroom.id, f.student)).manages_domain, false);
  await assertRejects(() => updateClassroom(f.school.slug, f.classroom.id, f.student, 2, { name: "越权" }), ForbiddenError);
  assertEquals((await getClassroom(f.school.slug, f.classroom.id, f.teacher)).manages_domain, true);
  await setMemberRole(f.school.slug, f.owner, f.teacher, "member");
  await assertRejects(() => getClassroom(f.school.slug, f.classroom.id, f.teacher), NotFoundError);
  await removeDomainMember(f.school.slug, f.owner, f.student);
  await assertRejects(() => getClassroom(f.school.slug, f.classroom.id, f.student), NotFoundError);
  assertEquals((await f.db.select().from(classrooms).where(eq(classrooms.id, f.classroom.id)))[0].id, f.classroom.id);
  assertEquals((await f.db.select().from(classroomMemberships).where(eq(classroomMemberships.user_id, f.student)))[0].status, "removed");
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
        {},
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
        { role: "assistant", capabilities: ["domain:settings"] as never },
      ),
    BadRequestError,
  );
});

Deno.test("教学撤权：重新入域不恢复旧班级的教练或助教权限", async () => {
  const f = await educationFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    0,
    {},
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
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
  assertEquals(stored.status, "removed");
});
