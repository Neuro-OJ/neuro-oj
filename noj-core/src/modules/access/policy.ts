/**
 * access 的工作空间只读授权政策。
 *
 * 这里的读路径接受一个明确的 UserActor/GuestActor，并在当前数据库连接
 * 上重新解析账号、平台权限、成员关系和域角色。它不从 Hono Context、ALS
 * 或客户端 role 字段获取身份。带锁的写流程只能调用
 * `loadWorkspaceTx(tx, ...)`，从而把授权重读放在同一个 DbTx 中。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  domainMemberships,
  domains,
  userBans,
  users,
} from "../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../shared/base/errors.ts";
import { getSetting } from "../platform/contracts/cross-module/services_system-settings.ts";
import { effectiveDomainConfiguration } from "../../shared/workspace/capabilities.ts";
import {
  type GuestActor,
  isUserActor,
  requireUserActor,
  type UserActor,
} from "./contracts/actor.ts";
import {
  type CapabilityName,
  type DomainMemberRole,
  type DomainRole,
  domainRoleCapabilities,
  isPlatformRole,
  type PlatformRole,
  platformRoleCapabilities,
  resolveEffectiveDomainRole,
} from "../../shared/access/roles.ts";

export type AccessActor = UserActor | GuestActor;

/**
 * 授权读取只需要根连接/事务句柄共有的查询能力；这里不再定义一个
 * `DbRoot | DbTx` 执行器联合，原子写路径仍通过下面的 `loadWorkspaceTx`
 * 明确要求真实 DbTx。
 */
type AccessReadDb = Pick<DbRoot, "select" | "execute">;

export interface WorkspaceAccessContext {
  readonly domainId: string;
  readonly domainSlug: string;
  readonly actor: AccessActor;
  /** 平台角色；匿名请求为 null。 */
  readonly platformRole: PlatformRole | null;
  /** 有效域角色；无活跃成员关系为 null，不默认成 member。 */
  readonly domainRole: DomainRole | null;
  readonly platformPermissions: ReadonlySet<CapabilityName>;
  readonly domainPermissions: ReadonlySet<CapabilityName>;
  readonly domainRevision: number;
  readonly platformAdmin: boolean;
}

export interface WorkspaceAccessResult {
  readonly domain: typeof domains.$inferSelect;
  readonly membership: typeof domainMemberships.$inferSelect | null;
  readonly context: WorkspaceAccessContext;
  readonly platformAdmin: boolean;
}

function instanceAccessPolicy(): "public" | "authenticated" {
  const value = getSetting("instance_access")?.value ?? "public";
  if (value !== "public" && value !== "authenticated") {
    throw new ServiceUnavailableError("实例访问政策无效，请联系管理员修复");
  }
  return value;
}

/** 在当前连接上校验账号状态并返回平台角色（DB 是唯一事实源）。 */
async function loadActivePlatformRole(
  actor: UserActor,
  db: AccessReadDb,
): Promise<PlatformRole> {
  const [account] = await db.select({ role: users.role }).from(users).where(
    and(eq(users.id, actor.userId), isNull(users.deleted_at)),
  );
  if (!account) throw new UnauthorizedError("账号不存在或已注销");
  if (!isPlatformRole(account.role)) {
    // 数据库 CHECK 应阻止非法值；这里 fail-closed，避免未知角色被当成管理员。
    throw new ServiceUnavailableError("账号平台角色无效，请联系管理员修复");
  }
  const [ban] = await db.select({ until: userBans.banned_until }).from(
    userBans,
  ).where(and(
    eq(userBans.user_id, actor.userId),
    eq(userBans.scope, "platform"),
    isNull(userBans.unbanned_at),
  )).orderBy(sql`${userBans.banned_at} DESC`).limit(1);
  if (ban && (!ban.until || Date.parse(ban.until) > Date.now())) {
    throw new ForbiddenError("账号已被封禁", "USER_BANNED");
  }
  return account.role;
}

function assertDomainAccess(domain: typeof domains.$inferSelect): void {
  if (
    domain.configuration?.access !== "public" &&
    domain.configuration?.access !== "members"
  ) {
    throw new ServiceUnavailableError("工作空间访问政策无效，请联系管理员修复");
  }
}

async function loadWorkspaceWithDb(
  db: AccessReadDb,
  slug: string,
  actor: AccessActor,
  options: { write?: boolean; lock?: boolean | "share" } = {},
): Promise<WorkspaceAccessResult> {
  if (instanceAccessPolicy() === "authenticated" && actor.kind === "guest") {
    throw new UnauthorizedError("此实例需要登录");
  }
  const platformRole = isUserActor(actor)
    ? await loadActivePlatformRole(actor, db)
    : null;
  const platformPermissions = platformRole
    ? platformRoleCapabilities(platformRole)
    : new Set<CapabilityName>();
  const platformAdmin = platformRole === "admin";
  const query = db.select().from(domains).where(eq(domains.slug, slug));
  const [rawDomain] = options.lock
    ? await query.for(options.lock === "share" ? "share" : "update")
    : await query;
  if (!rawDomain) throw new NotFoundError("工作空间不存在");
  const domain = {
    ...rawDomain,
    configuration: effectiveDomainConfiguration(
      rawDomain.preset,
      rawDomain.configuration,
    ),
  };
  assertDomainAccess(domain);
  if (domain.status === "suspended" && !platformAdmin) {
    throw new NotFoundError("工作空间不可用");
  }
  const [membership] = actor.kind === "user"
    ? await db.select().from(domainMemberships).where(and(
      eq(domainMemberships.domain_id, domain.id),
      eq(domainMemberships.user_id, actor.userId),
      eq(domainMemberships.status, "active"),
    ))
    : [];
  if (
    !platformAdmin && !membership && domain.configuration.access === "members"
  ) throw new NotFoundError("工作空间不存在或不可访问");
  if (options.write && domain.status !== "active") {
    throw new ForbiddenError("工作空间只读或停用", "DOMAIN_READ_ONLY");
  }
  const domainRole = actor.kind === "user" && membership
    ? resolveEffectiveDomainRole(actor.userId, domain, {
      role: membership.role as DomainMemberRole,
    })
    : null;
  const context: WorkspaceAccessContext = {
    domainId: domain.id,
    domainSlug: domain.slug,
    actor,
    platformRole,
    domainRole,
    platformPermissions,
    domainPermissions: domainRoleCapabilities(domainRole),
    domainRevision: domain.revision,
    platformAdmin,
  };
  return { domain, membership: membership ?? null, context, platformAdmin };
}

/** 独立只读入口；DbRoot 只在此类应用查询入口使用。 */
export function loadWorkspace(
  slug: string,
  actor: AccessActor,
  options: { write?: boolean; lock?: false | undefined } = {},
): Promise<WorkspaceAccessResult> {
  return loadWorkspaceWithDb(getDb(), slug, actor, options);
}

/** 原子写流程的只读授权重读；必须使用外层 DbTx。 */
export function loadWorkspaceTx(
  tx: DbTx,
  slug: string,
  actor: AccessActor,
  options: { write?: boolean; lock?: boolean | "share" } = {},
): Promise<WorkspaceAccessResult> {
  return loadWorkspaceWithDb(tx, slug, actor, options);
}

/** 跨域列表可复用的 SQL 可见性条件，匿名只看到公开域。 */
export function domainMemberWhere(
  domainId: unknown,
  actor: AccessActor,
) {
  const actorId = actor.kind === "user" ? actor.userId : null;
  return sql`EXISTS (SELECT 1 FROM domain_memberships access_member WHERE access_member.domain_id=${domainId}
    AND access_member.user_id=${actorId} AND access_member.status='active')`;
}

export function domainReadableWhere(
  domainId: unknown,
  actor: AccessActor,
  platformAdmin = false,
) {
  return sql`EXISTS (SELECT 1 FROM domains access_domain WHERE access_domain.id=${domainId} AND
    (${platformAdmin} OR (access_domain.status<>'suspended' AND
      (access_domain.configuration->>'access'='public' OR ${
    domainMemberWhere(domainId, actor)
  }))))`;
}

/** 业务授权只接受解析后的 access context，不接受 role 字符串。 */
export function assertWorkspacePermission(
  context: WorkspaceAccessContext,
  permission: CapabilityName,
): void {
  if (
    context.actor.kind !== "user" ||
    (!context.platformAdmin && !context.domainPermissions.has(permission))
  ) throw new ForbiddenError("工作空间权限不足", "DOMAIN_PERMISSION_DENIED");
}

/** 用户写入需要显式 UserActor；这里集中拒绝 Guest/System。 */
export function requireWorkspaceUser(actor: AccessActor): UserActor {
  return requireUserActor(actor);
}

/** 加入流程锁域前读取活跃域；调用者必须已处于 DbTx。 */
export async function loadDomainForJoiningTx(
  tx: DbTx,
  slug: string,
): Promise<typeof domains.$inferSelect> {
  const [domain] = await tx.select().from(domains).where(
    and(eq(domains.slug, slug), eq(domains.status, "active")),
  ).for("update");
  if (!domain) throw new NotFoundError("工作空间不可加入");
  assertDomainAccess(domain);
  if (
    ![
      "open",
      "approval",
      "invite",
    ].includes(domain.configuration.join_policy)
  ) {
    throw new ServiceUnavailableError("工作空间加入政策无效，请联系管理员修复");
  }
  return domain;
}
