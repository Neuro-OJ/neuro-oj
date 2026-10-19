import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { roles, userRoles, users } from "../../../../shared/db/schema.ts";
import { updateSetting } from "../../../system/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  joinDomain,
  listDomainInvitations,
  listDomainJoinRequests,
  listDomainMembers,
  previewDomainInvitation,
  setMemberRole,
  transferDomain,
} from "../../index.ts";

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

Deno.test("域管理视图：成员角色批量返回，注销身份不暴露旧邮箱", async () => {
  await resetDbForTest();
  const operator = await account(true);
  const member = await account();
  const domain = await createDomain({
    slug: "view-community",
    name: "社区",
    preset: "community",
  }, operator);
  await joinDomain(domain.slug, member);
  await setMemberRole(domain.slug, operator, member, "member");
  const list = await listDomainMembers(domain.slug, operator);
  assertEquals(list.find((row) => row.user_id === member)?.role, "member");
  assertEquals(list.find((row) => row.user_id === operator)?.is_owner, true);
  await getDb().update(users).set({ deleted_at: new Date().toISOString() })
    .where(eq(users.id, member));
  const deleted = (await listDomainMembers(domain.slug, operator)).find((row) =>
    row.user_id === member
  )!;
  assertEquals(deleted.username, "已注销用户");
  assertEquals(deleted.email, "");
});

Deno.test("加入申请视图：按域隔离，注销后隐藏用户名且不能批准", async () => {
  await resetDbForTest();
  const operator = await account(true);
  const applicant = await account();
  const outsider = await account();
  const domain = await createDomain({
    slug: "request-school",
    name: "学校",
    preset: "education",
  }, operator);
  const other = await createDomain({
    slug: "request-other",
    name: "其他学校",
    preset: "education",
  }, operator);
  const { updateDomain } = await import("../../index.ts");
  await updateDomain(domain.slug, operator, domain.revision, {
    configuration: {
      ...domain.configuration,
      discoverable: true,
      join_policy: "approval",
    },
  });
  await joinDomain(domain.slug, applicant, "申请加入");
  const requests = await listDomainJoinRequests(domain.slug, operator);
  assertEquals(requests.length, 1);
  assertEquals(requests[0].can_approve, true);
  assertEquals(requests[0].reason, "申请加入");
  assertEquals((await listDomainJoinRequests(other.slug, operator)).length, 0);
  await assertRejects(
    () => listDomainJoinRequests(domain.slug, outsider),
    NotFoundError,
  );
  await getDb().update(users).set({ deleted_at: new Date().toISOString() })
    .where(eq(users.id, applicant));
  const deleted = (await listDomainJoinRequests(domain.slug, operator))[0];
  assertEquals(deleted.username, "已注销用户");
  assertEquals(deleted.can_approve, false);
});

Deno.test("邀请视图：预览不枚举账号，目录不返回令牌或哈希，管理员开户不能绕过", async () => {
  await resetDbForTest();
  const operator = await account(true);
  const member = await account();
  const domain = await createDomain({
    slug: "view-school",
    name: "学校",
    preset: "education",
  }, operator);
  const invitation = await createDomainInvitation(
    domain.slug,
    operator,
    `${member}@example.com`,
  );
  await updateSetting("instance_registration_mode", "admin_only", operator);
  const preview = await previewDomainInvitation(invitation.token);
  assertEquals(preview.domain_slug, domain.slug);
  assertEquals(preview.can_register, false);
  assertEquals(Object.keys(preview).sort(), [
    "can_register",
    "domain_name",
    "domain_slug",
    "email",
    "expires_at",
    "max_uses",
    "mode",
    "used_count",
  ]);
  const list = await listDomainInvitations(domain.slug, operator);
  assertEquals(Object.keys(list.data[0]).sort(), [
    "classroom_id",
    "created_at",
    "email",
    "expires_at",
    "id",
    "max_uses",
    "mode",
    "revoked_at",
    "used_at",
    "used_count",
  ]);
  await consumeDomainInvitation(invitation.token, member);
  await assertRejects(
    () => previewDomainInvitation(invitation.token),
    NotFoundError,
  );
});

Deno.test("邀请视图：签发者撤权后预览和直接接受都立即拒绝", async () => {
  await resetDbForTest();
  const operator = await account(true);
  const issuer = await account();
  const recipient = await account();
  const domain = await createDomain({
    slug: "revoked-inviter",
    name: "社区",
    preset: "community",
  }, operator);
  await joinDomain(domain.slug, issuer);
  await transferDomain(domain.slug, operator, issuer);
  const invitation = await createDomainInvitation(
    domain.slug,
    issuer,
    `${recipient}@example.com`,
  );
  await previewDomainInvitation(invitation.token);
  await transferDomain(domain.slug, issuer, operator);
  await assertRejects(
    () => previewDomainInvitation(invitation.token),
    NotFoundError,
  );
  await assertRejects(
    () => consumeDomainInvitation(invitation.token, recipient),
    NotFoundError,
  );
  assertEquals(
    (await listDomainMembers(domain.slug, operator)).some((row) =>
      row.user_id === recipient
    ),
    false,
  );
});
