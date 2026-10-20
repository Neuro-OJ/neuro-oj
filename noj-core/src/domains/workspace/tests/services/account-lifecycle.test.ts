import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { ConflictError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  auditLogs,
  domainMemberRoles,
  domainMemberships,
  domainResourceCounters,
  domains,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  adminDeleteAccount,
  deleteOwnAccount,
  hashPassword,
} from "../../../identity/index.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
  joinDomain,
  loadWorkspace,
  setDomainStatus,
  transferDomain,
} from "../../index.ts";

async function account(admin = false) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    password_hash: await hashPassword("Owner-2026-Ab1"),
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

Deno.test("默认域负责人：排除系统账号，补齐首次管理员且重启不覆盖人工交接", async () => {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  assertEquals((await loadWorkspace("main", null)).domain.owner_id, "0");
  const operator = await account(true);
  await ensureDefaultWorkspace();
  const main = await loadWorkspace("main", operator);
  assertEquals(main.domain.owner_id, operator);
  assertEquals(main.context.domainPermissions.has("domain:transfer"), true);
  const next = await account();
  await joinDomain("main", next);
  await transferDomain("main", operator, next);
  await ensureDefaultWorkspace();
  assertEquals((await loadWorkspace("main", next)).domain.owner_id, next);
  const roots = await getDb().select().from(domainMemberships).where(
    and(
      eq(domainMemberships.domain_id, main.domain.id),
      eq(domainMemberships.user_id, "0"),
      eq(domainMemberships.status, "active"),
    ),
  );
  assertEquals(roots.length, 0);
});

Deno.test("域负责人注销：本人及平台入口均拒绝，拒绝时头像和身份不变；交接后可注销", async () => {
  await resetDbForTest();
  const operator = await account(true);
  const owner = await account();
  const next = await account();
  const domain = await createDomain(
    { slug: "lifecycle-school", name: "学校", preset: "community" },
    owner,
    { approved: true },
  );
  await getDb().update(users).set({
    avatar_url: "noj-storage://local/avatar-retained.png",
  }).where(eq(users.id, owner));
  for (
    const action of [
      () => deleteOwnAccount(owner, "Owner-2026-Ab1"),
      () => adminDeleteAccount(owner, operator),
    ]
  ) {
    const failure = await assertRejects(action, ConflictError);
    assertEquals(failure.code, "DOMAIN_OWNER_TRANSFER_REQUIRED");
    const [user] = await getDb().select().from(users).where(
      eq(users.id, owner),
    );
    assertEquals(user.deleted_at, null);
    assertEquals(user.avatar_url, "noj-storage://local/avatar-retained.png");
  }
  await joinDomain(domain.slug, next);
  await transferDomain(domain.slug, owner, next);
  await deleteOwnAccount(owner, "Owner-2026-Ab1");
  assertEquals((await loadWorkspace(domain.slug, next)).domain.owner_id, next);
  const [history] = await getDb().select().from(domainMemberships).where(
    eq(domainMemberships.user_id, owner),
  );
  assertEquals(!!history, true);
  assertEquals(history.status, "removed");
  const [counter] = await getDb().select().from(domainResourceCounters).where(
    and(
      eq(domainResourceCounters.domain_id, domain.id),
      eq(domainResourceCounters.resource, "members"),
    ),
  );
  assertEquals(counter.used, 1);
  const audit = await getDb().select().from(auditLogs).where(
    and(
      eq(auditLogs.target_id, domain.id),
      eq(auditLogs.action, "domain.member_remove"),
    ),
  );
  assertEquals(
    audit.some((entry) =>
      entry.admin_id === owner &&
      (entry.detail as Record<string, unknown>)?.operation === "account_deleted"
    ),
    true,
  );
});

Deno.test("停用域交接：普通负责人不能写入，平台治理可转交且保留单一 owner 角色", async () => {
  await resetDbForTest();
  const operator = await account(true);
  const owner = await account();
  const next = await account();
  const domain = await createDomain(
    { slug: "suspended-owner", name: "学校", preset: "community" },
    owner,
    { approved: true },
  );
  await joinDomain(domain.slug, next);
  await setDomainStatus(domain.slug, operator, "suspended", domain.revision);
  await assertRejects(() => transferDomain(domain.slug, owner, next));
  await transferDomain(domain.slug, operator, next);
  const [saved] = await getDb().select().from(domains).where(
    eq(domains.id, domain.id),
  );
  assertEquals(saved.owner_id, next);
  assertEquals(saved.status, "suspended");
  const roles = await getDb().select({ role: domainMemberRoles.role }).from(
    domainMemberRoles,
  ).innerJoin(
    domainMemberships,
    eq(domainMemberships.id, domainMemberRoles.membership_id),
  ).where(
    and(
      eq(domainMemberships.domain_id, domain.id),
      eq(domainMemberRoles.role, "owner"),
    ),
  );
  assertEquals(roles.length, 1);
});
