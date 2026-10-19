import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  auditLogs,
  domainInvitations,
  domainLimits,
  domainMemberships,
  domains,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { updateSetting } from "../../../system/index.ts";
import {
  assertWorkspacePermission,
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  ensureDefaultWorkspace,
  joinDomain,
  listDomains,
  loadWorkspace,
  removeDomainMember,
  requestDomainCreation,
  reviewDomainCreation,
  revokeDomainInvitation,
  setMemberRole,
  transferDomain,
  updateDomain,
} from "../../index.ts";

await resetDbForTest();

async function account(admin = false) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  if (admin) {
    const [role] = await getDb().select().from(roles).where(
      eq(roles.name, "admin"),
    );
    await getDb().insert(userRoles).values({ user_id: id, role_id: role.id });
  }
  return id;
}

Deno.test({
  name: "工作空间治理：跨域角色隔离、移除立即生效、负责人交接受保护",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const operator = await account(true);
    const student = await account();
    const other = await account();
    const school = await createDomain({
      slug: "school-one",
      name: "学校一",
      preset: "education",
    }, operator);
    const team = await createDomain({
      slug: "team-two",
      name: "团队二",
      preset: "team",
    }, operator);
    await assertRejects(
      () => loadWorkspace(school.slug, student),
      NotFoundError,
    );
    const invite = await createDomainInvitation(
      school.slug,
      operator,
      `${student}@example.com`,
    );
    await consumeDomainInvitation(invite.token, student);
    await setMemberRole(school.slug, operator, student, "coach");
    const access = await loadWorkspace(school.slug, student);
    assertWorkspacePermission(access.context, "classroom:manage_any");
    assertThrows(
      () => assertWorkspacePermission(access.context, "domain:settings"),
      ForbiddenError,
    );
    assert(!access.context.platformPermissions.has("admin:full_access"));
    await assertRejects(() => loadWorkspace(team.slug, student), NotFoundError);
    await assertRejects(
      () => removeDomainMember(school.slug, operator, operator),
      ConflictError,
    );
    await assertRejects(
      () => transferDomain(school.slug, student, other),
      ForbiddenError,
    );
    await transferDomain(school.slug, operator, student);
    assertEquals(
      (await loadWorkspace(school.slug, student)).domain.owner_id,
      student,
    );
    await removeDomainMember(school.slug, student, operator);
    // 全站管理员保留治理访问，域身份本身已经撤销。
    assertEquals((await loadWorkspace(school.slug, operator)).membership, null);
    const extra = await createDomainInvitation(
      school.slug,
      student,
      `${other}@example.com`,
    );
    await consumeDomainInvitation(extra.token, other);
    await setMemberRole(school.slug, student, other, "coach");
    await removeDomainMember(school.slug, student, other);
    await assertRejects(() => loadWorkspace(school.slug, other), NotFoundError);
    assertEquals((await listDomains(other, true)).length, 0);
    assertEquals(
      (await getDb().select().from(domains).where(eq(domains.id, school.id)))[0]
        .owner_id,
      student,
    );
  },
});

Deno.test({
  name: "工作空间治理：邀请单次绑定邮箱、可撤销、容量失败不消费邀请",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const owner = await account(true);
    const invited = await account();
    const wrong = await account();
    const domain = await createDomain({
      slug: "invite-school",
      name: "邀请学校",
      preset: "education",
    }, owner);
    const invite = await createDomainInvitation(
      domain.slug,
      owner,
      `${invited}@example.com`,
    );
    const [stored] = await getDb().select().from(domainInvitations).where(
      eq(domainInvitations.id, invite.id),
    );
    assert(stored.token_hash !== invite.token);
    await assertRejects(
      () => consumeDomainInvitation(invite.token, wrong),
      NotFoundError,
    );
    await getDb().update(domainLimits).set({ members: 1 }).where(
      eq(domainLimits.domain_id, domain.id),
    );
    await assertRejects(
      () => consumeDomainInvitation(invite.token, invited),
      ForbiddenError,
    );
    assertEquals(
      (await getDb().select().from(domainInvitations).where(
        eq(domainInvitations.id, invite.id),
      ))[0].used_at,
      null,
    );
    await getDb().update(domainLimits).set({ members: 2 }).where(
      eq(domainLimits.domain_id, domain.id),
    );
    await consumeDomainInvitation(invite.token, invited);
    assertEquals(
      (await consumeDomainInvitation(invite.token, invited)).domain_id,
      domain.id,
    );
    const revoked = await createDomainInvitation(
      domain.slug,
      owner,
      `${wrong}@example.com`,
    );
    await revokeDomainInvitation(domain.slug, owner, revoked.id);
    await assertRejects(
      () => consumeDomainInvitation(revoked.token, wrong),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "工作空间治理：配置 revision 防覆盖、类型能力固定、默认域幂等",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const owner = await account(true);
    const domain = await createDomain({
      slug: "config-school",
      name: "学校",
      preset: "education",
    }, owner);
    await assertRejects(() =>
      updateDomain(domain.slug, owner, 0, {
        configuration: {
          features: { ...domain.configuration.features, assignment: false },
        },
      }), BadRequestError);
    const changed = await updateDomain(domain.slug, owner, 0, {
      configuration: { access: "public" },
    });
    await assertRejects(
      () => updateDomain(domain.slug, owner, 0, { name: "错误覆盖" }),
      ConflictError,
    );
    await updateDomain(domain.slug, owner, changed.revision, {
      configuration: { access: "members" },
    });
    assertEquals(
      (await loadWorkspace(domain.slug, owner)).domain.preset,
      "education",
    );
    assertEquals(
      (await getDb().select().from(domainMemberships).where(
        eq(domainMemberships.domain_id, domain.id),
      )).length,
      1,
    );
    await ensureDefaultWorkspace();
    const main = await loadWorkspace("main", owner);
    await updateDomain("main", owner, main.domain.revision, {
      name: "保留配置",
    });
    await ensureDefaultWorkspace();
    assertEquals((await loadWorkspace("main", owner)).domain.name, "保留配置");
    assert(
      (await getDb().select().from(auditLogs)).some((item) =>
        item.action === "domain.update"
      ),
    );
  },
});

Deno.test({
  name: "工作空间治理：申请创建经平台批准，普通创建政策不能绕过",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const operator = await account(true);
    const applicant = await account();
    await assertRejects(
      () =>
        createDomain(
          { slug: "new-school", name: "学校", preset: "education" },
          applicant,
        ),
      ForbiddenError,
    );
    await updateSetting("domain_creation_policy", "approval", operator);
    const request = await requestDomainCreation(applicant, {
      slug: "new-school",
      name: "学校",
      preset: "education",
      reason: "教学",
    });
    assertEquals(
      (await requestDomainCreation(applicant, {
        slug: "new-school",
        name: "学校",
        preset: "education",
        reason: "教学",
      })).id,
      request.id,
    );
    await assertRejects(
      () => reviewDomainCreation(request.id, applicant, true),
      ForbiddenError,
    );
    const reviewed = await reviewDomainCreation(request.id, operator, true);
    assertEquals(reviewed.status, "approved");
    assertEquals(
      (await loadWorkspace("new-school", applicant)).domain.owner_id,
      applicant,
    );
    await assertRejects(
      () => reviewDomainCreation(request.id, operator, true),
      ConflictError,
    );
    const publicDomain = await createDomain({
      slug: "public-domain",
      name: "公开域",
      preset: "community",
    }, operator);
    await joinDomain(publicDomain.slug, applicant);
    assertEquals(
      (await loadWorkspace(publicDomain.slug, applicant)).membership?.status,
      "active",
    );
  },
});
