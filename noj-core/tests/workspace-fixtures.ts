import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/shared/db/connection.ts";
import { domainMemberRoles, domainMemberships, domains, users } from "../src/shared/db/schema.ts";
import { addDomainMember, DEFAULT_DOMAIN_ID, ensureDefaultWorkspace, presetConfiguration } from "../src/domains/workspace/index.ts";

const FIXTURE_OWNER_ID = "00000000-0000-4000-8000-000000000019";

/** 多个资源管理者的旧 main 用例显式使用教学域；不让平台身份或旧组合角色代替域授权。 */
export async function ensureTeachingMainForTest() {
  await ensureDefaultWorkspace();
  const db = getDb(), [main] = await db.select().from(domains).where(eq(domains.id, DEFAULT_DOMAIN_ID));
  if (main.owner_id === FIXTURE_OWNER_ID && main.preset === "education") return;
  const now = new Date().toISOString();
  await db.insert(users).values({ id: FIXTURE_OWNER_ID, username: "fixture_domain_owner", email: "fixture-domain-owner@example.com", created_at: now, updated_at: now }).onConflictDoNothing();
  const owner = await addDomainMember(db, DEFAULT_DOMAIN_ID, FIXTURE_OWNER_ID, true);
  const memberships = await db.select({ id: domainMemberships.id }).from(domainMemberships).where(eq(domainMemberships.domain_id, DEFAULT_DOMAIN_ID));
  await db.update(domainMemberRoles).set({ role: "member" }).where(and(inArray(domainMemberRoles.membership_id, memberships.map(member => member.id)), eq(domainMemberRoles.role, "owner")));
  await db.delete(domainMemberRoles).where(eq(domainMemberRoles.membership_id, owner.id));
  await db.insert(domainMemberRoles).values({ membership_id: owner.id, role: "owner" });
  const system = await addDomainMember(db, DEFAULT_DOMAIN_ID, "0", true);
  await db.delete(domainMemberRoles).where(eq(domainMemberRoles.membership_id, system.id));
  await db.insert(domainMemberRoles).values({ membership_id: system.id, role: "coach" });
  await db.update(domains).set({ owner_id: FIXTURE_OWNER_ID, preset: "education", configuration: { ...main.configuration, features: presetConfiguration("education").features } }).where(eq(domains.id, DEFAULT_DOMAIN_ID));
}

/** 授予真实、单值的 coach/member，负责人始终是独立的夹具账号。 */
export async function grantTeachingMainRoleForTest(userId: string, role: "coach" | "member" = "coach") {
  await ensureTeachingMainForTest();
  const db = getDb(), membership = await addDomainMember(db, DEFAULT_DOMAIN_ID, userId, true);
  if (userId !== FIXTURE_OWNER_ID) {
    await db.delete(domainMemberRoles).where(eq(domainMemberRoles.membership_id, membership.id));
    await db.insert(domainMemberRoles).values({ membership_id: membership.id, role });
  }
  return membership;
}
