import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  domainInvitations,
  domainMemberRoles,
  domainMemberships,
} from "../../../../shared/db/schema.ts";
import {
  account,
  educationFixture,
} from "../../../education/tests/_fixtures.ts";
import {
  createClassroom,
  createClassroomInvitation,
  listClassrooms,
  loadClassroom,
} from "../../../education/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  loadWorkspace,
  setMemberRole,
  transferDomain,
} from "../../index.ts";

Deno.test("单一域角色：教练管理所有班级，但不获得成员、设置或跨域治理权限", async () => {
  const f = await educationFixture();
  const second = await createClassroom(f.school.slug, f.owner, {
    name: "二班",
  });
  assert(
    (await listClassrooms(f.school.slug, f.teacher)).some((c) =>
      c.id === second.id
    ),
  );
  assertEquals(
    (await loadClassroom(f.school.slug, second.id, f.teacher)).managesDomain,
    true,
  );
  assertEquals((await loadWorkspace(f.school.slug, f.teacher)).role, "coach");
  for (
    const key of [
      "domain:members",
      "domain:settings",
      "domain:invitations",
      "llm:manage",
    ]
  ) {
    assert(
      !(await loadWorkspace(f.school.slug, f.teacher)).context.domainPermissions
        .has(key),
    );
  }
  await assertRejects(
    () =>
      createDomainInvitation(
        f.school.slug,
        f.teacher,
        `${f.student}@example.com`,
      ),
    ForbiddenError,
  );
  await assertRejects(
    () => setMemberRole(f.school.slug, f.teacher, f.student, "coach"),
    ForbiddenError,
  );
  assertEquals((await loadWorkspace(f.other.slug, f.teacher)).role, "member");
});

Deno.test("单一域角色：降级立即撤销教学权限，旧班级教练任职和联系人不能恢复权限", async () => {
  const f = await educationFixture();
  await f.db.insert(classroomMemberships).values({
    id: crypto.randomUUID(),
    domain_id: f.school.id,
    classroom_id: f.classroom.id,
    user_id: f.teacher,
    role: "coach",
    joined_at: new Date().toISOString(),
    appointed_at: new Date().toISOString(),
  });
  await setMemberRole(f.school.slug, f.owner, f.teacher, "member");
  await assertRejects(
    () => loadClassroom(f.school.slug, f.classroom.id, f.teacher),
    NotFoundError,
  );
  assertEquals((await listClassrooms(f.school.slug, f.teacher)).length, 0);
  assertEquals(
    (await loadWorkspace(f.school.slug, f.teacher)).context.domainPermissions
      .has("submission:read_all"),
    false,
  );
});

Deno.test("单一域角色：普通域拒绝教练，负责人交接后原负责人恢复成员", async () => {
  const f = await educationFixture();
  const community = await createDomain({
    slug: "role-community",
    name: "社区",
    preset: "community",
  }, f.owner);
  await assertRejects(
    () => setMemberRole(community.slug, f.owner, f.student, "coach"),
    BadRequestError,
  );
  await transferDomain(f.school.slug, f.owner, f.student);
  assertEquals((await loadWorkspace(f.school.slug, f.owner)).role, "member");
  assertEquals((await loadWorkspace(f.school.slug, f.student)).role, "owner");
  await assertRejects(
    () => setMemberRole(f.school.slug, f.owner, f.teacher, "member"),
    ForbiddenError,
  );
  const [row] = await f.db.select().from(domainMemberRoles).where(
    eq(domainMemberRoles.role, "owner"),
  );
  assert(row);
});

Deno.test("单一域角色：教练班级邀请只能调整已有域成员，不可新增域成员或消费失败邀请", async () => {
  const f = await educationFixture(), outsider = await account();
  const invite = await createClassroomInvitation(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    { mode: "general", max_uses: 3 },
  );
  await assertRejects(
    () => consumeDomainInvitation(invite.token, outsider),
    ForbiddenError,
  );
  const [stored] = await f.db.select().from(domainInvitations).where(
    eq(domainInvitations.id, invite.id),
  );
  assertEquals(stored.used_count, 0);
  await consumeDomainInvitation(invite.token, f.student);
  assertEquals(
    (await loadClassroom(f.school.slug, f.classroom.id, f.student))
      .managesDomain,
    false,
  );
});

Deno.test("单一域角色：存量多角色升级不自动提升全域教练，保留学生关系和联系人", async () => {
  const f = await educationFixture();
  await f.db.execute(
    sql.raw(
      "ALTER TABLE domain_member_roles DROP CONSTRAINT domain_member_roles_membership_unique",
    ),
  );
  await f.db.execute(
    sql.raw(
      "ALTER TABLE domain_member_roles DROP CONSTRAINT domain_member_roles_role_check",
    ),
  );
  await f.db.delete(domainMemberRoles);
  await f.db.execute(
    sql.raw(
      "ALTER TABLE domain_member_roles ADD CONSTRAINT domain_member_roles_role_check CHECK (role IN ('owner','admin','editor','educator','moderator','member'))",
    ),
  );
  const memberships = await f.db.select().from(domainMemberships);
  await f.db.insert(domainMemberRoles).values(memberships.flatMap((m) => [
    { membership_id: m.id, role: "member" },
    { membership_id: m.id, role: "editor" },
  ]));
  const now = new Date().toISOString();
  await f.db.insert(classroomMemberships).values([
    {
      id: crypto.randomUUID(),
      domain_id: f.school.id,
      classroom_id: f.classroom.id,
      user_id: f.teacher,
      role: "coach",
      joined_at: now,
      appointed_at: now,
    },
    {
      id: crypto.randomUUID(),
      domain_id: f.school.id,
      classroom_id: f.classroom.id,
      user_id: f.assistant,
      role: "assistant",
      joined_at: now,
      appointed_at: now,
    },
    {
      id: crypto.randomUUID(),
      domain_id: f.school.id,
      classroom_id: f.classroom.id,
      user_id: f.student,
      role: "student",
      joined_at: now,
      appointed_at: now,
    },
  ]);
  for (
    const name of [
      "0120_domain_role_backfill.sql",
      "0121_single_domain_roles.sql",
    ]
  ) {
    const migration = await Deno.readTextFile(
      new URL(`../../../../../drizzle/${name}`, import.meta.url),
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await f.db.execute(sql.raw(statement));
    }
  }
  assertEquals((await loadWorkspace(f.school.slug, f.owner)).role, "owner");
  assertEquals((await loadWorkspace(f.school.slug, f.teacher)).role, "member");
  assertEquals(
    (await loadWorkspace(f.school.slug, f.assistant)).role,
    "member",
  );
  const rows = await f.db.select().from(classroomMemberships);
  assertEquals(rows.find((r) => r.user_id === f.teacher)!.status, "removed");
  assertEquals(rows.find((r) => r.user_id === f.assistant)!.status, "removed");
  assertEquals(rows.find((r) => r.user_id === f.student)!.status, "active");
  assertEquals(
    (await loadClassroom(f.school.slug, f.classroom.id, f.owner)).classroom
      .primary_coach_id,
    f.teacher,
  );
  assertEquals(
    (await f.db.select().from(domainMemberRoles)).length,
    memberships.length,
  );
});
