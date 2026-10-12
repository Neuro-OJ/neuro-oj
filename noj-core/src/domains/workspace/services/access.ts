import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainMemberRoles,
  domainMemberships,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import type { WorkspaceContext } from "../../../shared/workspace/types.ts";
import { getUserPermissions } from "../../identity/index.ts";
import { domainPermissions, validateDomainConfiguration } from "../types.ts";
import { getInstanceAccessPolicy } from "./instance.ts";

/** 服务端实时解析域身份、成员及平台权限，不信任客户端的权限或上次使用域。 */
export async function loadWorkspace(
  slug: string,
  actorId: string | null,
  options: { write?: boolean; lock?: boolean | "share"; executor?: Executor } =
    {},
) {
  const db = options.executor ?? getDb();
  const query = db.select().from(domains).where(eq(domains.slug, slug));
  const [domain] = options.lock
    ? await query.for(options.lock === "share" ? "share" : "update")
    : await query;
  if (!domain) throw new NotFoundError("工作空间不存在");
  const platformPermissions = actorId
    ? await getUserPermissions(actorId, db)
    : new Set<string>();
  const platformAdmin = platformPermissions.has("admin:full_access");
  if (getInstanceAccessPolicy().access === "authenticated" && !actorId) {
    throw new UnauthorizedError("此实例需要登录");
  }
  if (actorId) {
    const [actor] = await db.select({ id: users.id }).from(users).where(
      and(eq(users.id, actorId), isNull(users.deleted_at)),
    );
    if (!actor) throw new UnauthorizedError("账号不可用");
  }
  validateDomainConfiguration(domain.configuration);
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
  validateDomainConfiguration(domain.configuration);
  return domain;
}
