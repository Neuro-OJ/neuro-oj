import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import {
  getDb,
  resetDbForTest as resetDatabase,
} from "../../../shared/db/connection.ts";
import {
  domainMemberRoles,
  domainMemberships,
} from "../../../shared/db/schema.ts";
import { createUserToken } from "../../../../tests/helper.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../workspace/index.ts";

/** 旧默认域用例显式建立实例管理员与 main，生产权限不依赖测试兜底。 */
export async function resetDbForTest(): Promise<void> {
  await resetDatabase();
  await createUserToken("admin");
  await ensureDefaultWorkspace();
  // 旧内部初始化用例明确授予系统账号本域管理能力；普通测试账号按用例单独授予。
  await grantDefaultCatalogRole("0", "admin");
}

/** 显式赋予测试账号 member / editor / admin，避免把普通用户自动升级。 */
export async function grantDefaultCatalogRole(
  userId: string,
  role: "member" | "editor" | "admin",
) {
  const db = getDb();
  const [existing] = await db.select().from(domainMemberships).where(
    and(
      eq(domainMemberships.user_id, userId),
      eq(domainMemberships.domain_id, DEFAULT_DOMAIN_ID),
    ),
  );
  const membershipId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await db.insert(domainMemberships).values({
      id: membershipId,
      domain_id: DEFAULT_DOMAIN_ID,
      user_id: userId,
      joined_at: new Date().toISOString(),
    });
  }
  await db.insert(domainMemberRoles).values({
    membership_id: membershipId,
    role,
  })
    .onConflictDoNothing();
}

/** 建立具有指定默认域角色的测试凭据。 */
export async function createDefaultCatalogToken(
  role: "member" | "editor" | "admin",
) {
  const token = await createUserToken(role === "admin" ? "admin" : "user");
  await grantDefaultCatalogRole(decodeJwt(token).sub!, role);
  return token;
}

/** 直接删除测试账号前显式清理其默认域关系；产品采用软删除保留历史。 */
export async function removeDefaultCatalogMembership(userId: string) {
  const db = getDb();
  const [membership] = await db.select().from(domainMemberships).where(
    and(
      eq(domainMemberships.user_id, userId),
      eq(domainMemberships.domain_id, DEFAULT_DOMAIN_ID),
    ),
  );
  if (!membership) return;
  await db.delete(domainMemberRoles).where(
    eq(domainMemberRoles.membership_id, membership.id),
  );
  await db.delete(domainMemberships).where(
    eq(domainMemberships.id, membership.id),
  );
}
