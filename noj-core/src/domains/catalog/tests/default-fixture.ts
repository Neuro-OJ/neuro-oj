import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { getDb } from "../../../shared/db/connection.ts";
import { resetDbForTest as resetDatabase } from "../../../../tests/helpers/db.ts";
import {
  domainMemberRoles,
  domainMemberships,
  domainProblemBindings,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import { createUserToken } from "../../../../tests/helper.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../workspace/index.ts";
import { deriveDraftContentFromProblem } from "../services/versioning/draft.ts";

/** 原始 SQL 夹具显式建立已发布版本和 main 绑定，不在产品读路径补历史数据。 */
export async function publishDefaultCatalogFixture(problemId: string) {
  const db = getDb(), now = new Date().toISOString();
  const [problem] = await db.select().from(problems).where(
    eq(problems.id, problemId),
  );
  const versionId = crypto.randomUUID();
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    content: await deriveDraftContentFromProblem(problem),
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  await bindDefaultCatalogFixture(problemId);
  return versionId;
}

/** 原始身份行模拟已完成归属迁移，绑定不代替发布。 */
export async function bindDefaultCatalogFixture(problemId: string) {
  const db = getDb(), now = new Date().toISOString();
  const [problem] = await db.select().from(problems).where(
    eq(problems.id, problemId),
  );
  await db.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: DEFAULT_DOMAIN_ID,
    problem_id: problemId,
    kind: "owned",
    visibility: problem.visibility === "public" ? "public" : "members",
    created_by: problem.owner_id ?? "0",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
}

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
