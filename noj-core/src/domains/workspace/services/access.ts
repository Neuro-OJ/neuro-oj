import { and, type AnyColumn, eq, type SQL, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainMemberRoles,
  domainMemberships,
  domains,
} from "../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import type { WorkspaceContext } from "../../../shared/workspace/types.ts";
import {
  assertActiveInstanceAccount,
  getUserPermissions,
} from "../../identity/index.ts";
import { domainPermissions } from "../types.ts";
import { getInstanceAccessPolicy } from "./instance.ts";
import { effectiveDomainConfiguration } from "../../../shared/workspace/capabilities.ts";

/** 跨域目录在数据库分页前检查当前成员关系，不从缓存枚举允许的域。 */
export function domainMemberWhere(
  domainId: AnyColumn | SQL,
  actorId: string | null,
): SQL {
  return sql`EXISTS (SELECT 1 FROM domain_memberships access_member WHERE access_member.domain_id=${domainId}
    AND access_member.user_id=${actorId} AND access_member.status='active')`;
}
/** 公共目录及本人可进入的私有域；平台治理权限显式传入。 */
export function domainReadableWhere(
  domainId: AnyColumn | SQL,
  actorId: string | null,
  platformAdmin = false,
): SQL {
  return sql`EXISTS (SELECT 1 FROM domains access_domain WHERE access_domain.id=${domainId} AND
    (${platformAdmin} OR (access_domain.status<>'suspended' AND
      (access_domain.configuration->>'access'='public' OR ${
    domainMemberWhere(domainId, actorId)
  }))))`;
}

/** 读取仅验证进入域所需字段，导航及其他模块配置由其边界处理。 */
function assertDomainAccess(domain: typeof domains.$inferSelect) {
  if (
    domain.configuration?.access !== "public" &&
    domain.configuration?.access !== "members"
  ) throw new ServiceUnavailableError("工作空间访问政策无效，请联系管理员修复");
}

/** 服务端实时解析域身份、成员及平台权限，不信任客户端的权限或上次使用域。 */
export async function loadWorkspace(
  slug: string,
  actorId: string | null,
  options: { write?: boolean; lock?: boolean | "share"; executor?: Executor } =
    {},
) {
  const db = options.executor ?? getDb();
  if (getInstanceAccessPolicy().access === "authenticated" && !actorId) {
    throw new UnauthorizedError("此实例需要登录");
  }
  if (actorId) await assertActiveInstanceAccount(actorId, db);
  const query = db.select().from(domains).where(eq(domains.slug, slug));
  const [domain] = options.lock
    ? await query.for(options.lock === "share" ? "share" : "update")
    : await query;
  if (!domain) throw new NotFoundError("工作空间不存在");
  domain.configuration = effectiveDomainConfiguration(
    domain.preset,
    domain.configuration,
  );
  const platformPermissions = actorId
    ? await getUserPermissions(actorId, db)
    : new Set<string>();
  const platformAdmin = platformPermissions.has("admin:full_access");
  assertDomainAccess(domain);
  if (domain.status === "suspended" && !platformAdmin) {
    throw new NotFoundError("工作空间不可用");
  }
  const [membership] = actorId
    ? await db.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, actorId),
        eq(domainMemberships.status, "active"),
      ),
    )
    : [];
  if (
    !platformAdmin && !membership && domain.configuration.access === "members"
  ) throw new NotFoundError("工作空间不存在或不可访问");
  if (options.write && domain.status !== "active") {
    throw new ForbiddenError("工作空间只读或停用", "DOMAIN_READ_ONLY");
  }
  const roles = membership
    ? await db.select({ role: domainMemberRoles.role }).from(domainMemberRoles)
      .where(eq(domainMemberRoles.membership_id, membership.id))
    : [];
  const context: WorkspaceContext = {
    domainId: domain.id,
    domainSlug: domain.slug,
    actorId,
    platformPermissions,
    domainPermissions: domainPermissions(roles.map((row) => row.role)),
    domainRevision: domain.revision,
  };
  return { domain, membership: membership ?? null, context, platformAdmin };
}

/** 域内能力断言；平台管理员例外来自服务端实时 RBAC。 */
export function assertWorkspacePermission(
  context: WorkspaceContext,
  permission: string,
) {
  if (
    !context.actorId ||
    !context.platformPermissions.has("admin:full_access") &&
      !context.domainPermissions.has(permission)
  ) throw new ForbiddenError("工作空间权限不足", "DOMAIN_PERMISSION_DENIED");
}

/** 成员加入入口能处理尚非成员的私有域，同时不返回域的私有内容。 */
export async function loadDomainForJoining(
  slug: string,
  executor: Executor = getDb(),
) {
  const [domain] = await executor.select().from(domains).where(
    and(eq(domains.slug, slug), eq(domains.status, "active")),
  ).for("update");
  if (!domain) throw new NotFoundError("工作空间不可加入");
  assertDomainAccess(domain);
  if (
    !["open", "approval", "invite"].includes(domain.configuration.join_policy)
  ) {
    throw new ServiceUnavailableError("工作空间加入政策无效，请联系管理员修复");
  }
  return domain;
}
