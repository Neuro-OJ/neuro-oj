import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { registrationInvitationBoundary } from "../../../application/index.ts";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  domainInvitations,
  domainLimits,
  domainMemberRoles,
  domainMemberships,
} from "../../../../shared/db/schema.ts";
import {
  createClassroomInvitation,
  listClassroomInvitations,
  revokeClassroomInvitation,
  setClassroomMember,
  updateClassroom,
} from "../../index.ts";
import {
  consumeDomainInvitationCommand,
  previewDomainInvitationCommand,
} from "../../../application/index.ts";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import { enrollRegisteredAccountTxLegacy } from "../../../access/workspace/index.ts";
import { assertInstanceRegistration } from "../../../access/index.ts";
import { updateSetting } from "../../../platform/system/index.ts";
import { registerUser } from "../../../access/identity/index.ts";
import { users } from "../../../../shared/db/schema.ts";
import { account, educationFixture } from "../_fixtures.ts";

const consumeDomainInvitation = (token: string, userId: string) =>
  consumeDomainInvitationCommand(userActorFromAuthenticatedId(userId), token);
const previewDomainInvitation = (token: string) =>
  previewDomainInvitationCommand(token);

Deno.test("班级邀请：原子加入域基础成员和学生，令牌仅存哈希，身份不匹配不能使用", async () => {
  const f = await educationFixture(), student = await account();
  const invite = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    `${student}@example.com`,
  );
  const preview = await previewDomainInvitation(invite.token);
  assertEquals(preview.classroom_id, f.classroom.id);
  assertEquals(preview.classroom_name, f.classroom.name);
  const [stored] = await f.db.select().from(domainInvitations).where(
    eq(domainInvitations.id, invite.id),
  );
  assertEquals(stored.token_hash === invite.token, false);
  await assertRejects(
    () => consumeDomainInvitation(invite.token, f.assistant),
    NotFoundError,
  );
  await consumeDomainInvitation(invite.token, student);
  const [member] = await f.db.select().from(domainMemberships).where(
    and(
      eq(domainMemberships.user_id, student),
      eq(domainMemberships.domain_id, f.school.id),
    ),
  );
  assertEquals(
    (await f.db.select().from(domainMemberRoles).where(
      eq(domainMemberRoles.membership_id, member.id),
    )).map((r) => r.role),
    ["member"],
  );
  assertEquals(
    (await f.db.select().from(classroomMemberships).where(
      eq(classroomMemberships.user_id, student),
    ))[0].role,
    "student",
  );
  assertEquals(
    (await consumeDomainInvitation(invite.token, student)).domain_id,
    f.school.id,
  );
  const { data: directory } = await listClassroomInvitations(
    f.school.slug,
    f.classroom.id,
    f.teacher,
  );
  assertEquals("token" in directory[0], false);
  assertEquals("token_hash" in directory[0], false);
});

Deno.test("班级邀请：成员额度失败回滚两层加入和消费；撤权、撤销及归档立即失效", async () => {
  const f = await educationFixture(), student = await account();
  const invite = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    `${student}@example.com`,
  );
  await f.db.insert(domainLimits).values({ domain_id: f.school.id, members: 4 })
    .onConflictDoUpdate({
      target: domainLimits.domain_id,
      set: { members: 4 },
    });
  await assertRejects(
    () => consumeDomainInvitation(invite.token, student),
    ForbiddenError,
  );
  assertEquals(
    (await f.db.select().from(classroomMemberships).where(
      eq(classroomMemberships.user_id, student),
    )).length,
    0,
  );
  assertEquals(
    (await f.db.select().from(domainInvitations).where(
      eq(domainInvitations.id, invite.id),
    ))[0].used_at,
    null,
  );
  await revokeClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    invite.id,
  );
  await assertRejects(
    () => previewDomainInvitation(invite.token),
    NotFoundError,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    0,
    { role: "assistant", capabilities: ["students:manage"] },
  );
  const ta = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.assistant,
    `${student}@example.com`,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  await assertRejects(() => previewDomainInvitation(ta.token), NotFoundError);
  const archived = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    `${student}@example.com`,
  );
  await updateClassroom(f.school.slug, f.classroom.id, f.teacher, 2, {
    archive: true,
  });
  await assertRejects(
    () => consumeDomainInvitation(archived.token, student),
    NotFoundError,
  );
});

Deno.test("邀请注册：班级能力不等于开户能力，管理员开户政策不能绕过", async () => {
  const f = await educationFixture(), student = await account();
  const coachInvite = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    `${student}@example.com`,
  );
  await updateSetting("instance_registration_mode", "invite", "0");
  await updateSetting("allow_domain_registration_invites", true, "0");
  await assertRejects(
    () =>
      f.db.transaction((tx) =>
        enrollRegisteredAccountTxLegacy(tx, student, coachInvite.token, {
          invitationBoundary: registrationInvitationBoundary(),
        })
      ),
    ForbiddenError,
  );
  const adminInvite = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.owner,
    `${student}@example.com`,
  );
  await f.db.transaction((tx) =>
    enrollRegisteredAccountTxLegacy(tx, student, adminInvite.token, {
      invitationBoundary: registrationInvitationBoundary(),
    })
  );
  assertEquals(
    (await f.db.select().from(classroomMemberships).where(
      eq(classroomMemberships.user_id, student),
    ))[0].role,
    "student",
  );
  await updateSetting("instance_registration_mode", "admin_only", "0");
  const error = assertThrows(
    () => assertInstanceRegistration(coachInvite.token),
    AppError,
  );
  assertEquals(error.code, "REGISTER_ADMIN_ONLY");
});

Deno.test("班级邀请注册：账号与两层成员同事务，额度失败不留下半注册账号", async () => {
  const f = await educationFixture(), key = crypto.randomUUID();
  await updateSetting("instance_registration_mode", "invite", "0");
  await updateSetting("allow_domain_registration_invites", true, "0");
  const email = `${key}@example.com`;
  const invite = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.owner,
    email,
  );
  const registered = await registerUser(
    {
      username: `student-${key.slice(0, 8)}`,
      email,
      password: "NewStudentPass123!",
      invitation_token: invite.token,
    },
    undefined,
    null,
    {
      invitationBoundary: registrationInvitationBoundary(),
    },
  );
  const [member] = await f.db.select().from(classroomMemberships)
    .where(eq(classroomMemberships.user_id, registered.id));
  assertEquals(member.role, "student");
  await f.db.insert(domainLimits).values({ domain_id: f.school.id, members: 5 })
    .onConflictDoUpdate({
      target: domainLimits.domain_id,
      set: { members: 5 },
    });
  const secondEmail = `second-${key}@example.com`;
  const blocked = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.owner,
    secondEmail,
  );
  await assertRejects(() =>
    registerUser(
      {
        username: `blocked-${key.slice(0, 8)}`,
        email: secondEmail,
        password: "NewStudentPass123!",
        invitation_token: blocked.token,
      },
      undefined,
      null,
      {
        invitationBoundary: registrationInvitationBoundary(),
      },
    ), ForbiddenError);
  assertEquals(
    (await f.db.select().from(users).where(eq(users.email, secondEmail)))
      .length,
    0,
  );
  assertEquals(
    (await f.db.select().from(domainInvitations).where(
      eq(domainInvitations.id, blocked.id),
    ))[0].used_at,
    null,
  );
});
