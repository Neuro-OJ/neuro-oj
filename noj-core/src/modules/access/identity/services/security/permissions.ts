/**
 * 平台角色与能力检查。
 *
 * 唯一授权事实是 `users.role`（单值 user/admin）。本模块只做三件事：
 * - 读取平台角色（按请求缓存，一请求一次 DB 查询）；
 * - 把角色映射成只读能力集合（`shared/access/roles.ts` 的静态映射）；
 * - 提供路由守卫与 handler 内的断言函数。
 *
 * JWT 中的 role 仅供客户端展示；本模块任何函数都不读取 token 角色。
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getDb } from "../../../../../shared/db/connection.ts";
import type { DbRoot, DbTx } from "../../../../../shared/db/executor.ts";
import {
  ForbiddenError,
  UnauthorizedError,
} from "../../../../../shared/base/errors.ts";
import {
  domainMemberships,
  domains,
  users,
} from "../../../../../shared/db/schema.ts";
import {
  type CapabilityName,
  domainRoleCapabilities,
  isPlatformRole,
  type PlatformRole,
  platformRoleCapabilities,
  resolveEffectiveDomainRole,
} from "../../../../../shared/access/roles.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../../shared/workspace/types.ts";

type Executor = DbRoot | DbTx;

/** 一次请求内缓存平台角色，避免同一请求重复查询。 */
const PLATFORM_ROLE_CACHE = Symbol.for("noj.platformRole");

interface RoleCacheCarrier {
  [PLATFORM_ROLE_CACHE]?: PlatformRole;
}

const ROOT_USER_ID = "0";

/**
 * 读取当前账号的平台角色。
 *
 * 账号不存在、已注销或角色值非法时返回 null（fail-closed），调用方按无权限处理。
 */
export async function findPlatformRole(
  userId: string,
  executor?: Executor,
): Promise<PlatformRole | null> {
  const db = executor ?? getDb();
  const [row] = await db.select({ role: users.role }).from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  ).limit(1);
  if (!row) return null;
  return isPlatformRole(row.role) ? row.role : null;
}

/** 单用户是否平台管理员；账号不存在时返回 false。 */
export async function isUserAdmin(
  userId: string,
  executor?: Executor,
): Promise<boolean> {
  return (await findPlatformRole(userId, executor)) === "admin";
}

/**
 * 用户的能力集合（平台维度）。
 *
 * 保留旧函数名以缩小调用面迁移；语义已改为“平台角色静态能力”，不再查角色表。
 */
export async function getUserPermissions(
  userId: string,
  executor?: Executor,
): Promise<ReadonlySet<CapabilityName>> {
  const role = await findPlatformRole(userId, executor);
  return role ? platformRoleCapabilities(role) : new Set();
}

/**
 * 批量查询平台管理员 ID。
 *
 * 排除 root 系统账号、已注销用户与处于有效平台封禁中的账号：这些账号不计入
 * “可用管理员”统计，最后一个管理员保护依赖同一口径。
 */
export async function getAdminUserIds(
  executor?: Executor,
): Promise<Set<string>> {
  const db = executor ?? getDb();
  const rows = await db.select({ id: users.id }).from(users).where(
    and(
      eq(users.role, "admin"),
      isNull(users.deleted_at),
      ne(users.id, ROOT_USER_ID),
      sql`NOT EXISTS (
        SELECT 1 FROM user_bans admin_ban
        WHERE admin_ban.user_id = ${users.id}
          AND admin_ban.scope = 'platform'
          AND admin_ban.unbanned_at IS NULL
          AND (admin_ban.banned_until IS NULL OR admin_ban.banned_until > ${
        new Date().toISOString()
      })
      )`,
    ),
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * 旧路由守卫（社区治理、题单管理、竞赛查重等）以 main 域为默认工作空间：
 * 请求能力集合 = 平台角色能力 ∪ 当前账号在 main 的有效域角色能力。
 *
 * 域内路由若显式携带其他域上下文，仍必须走 workspace access 的显式判定，
 * 不能把这里的结果当成跨域授权。
 */
async function resolveMainDomainCapabilities(
  userId: string | undefined,
): Promise<ReadonlySet<CapabilityName>> {
  if (!userId) return new Set();
  const [row] = await getDb().select({
    owner_id: domains.owner_id,
    role: domainMemberships.role,
  }).from(domains).leftJoin(
    domainMemberships,
    and(
      eq(domainMemberships.domain_id, domains.id),
      eq(domainMemberships.user_id, userId),
      eq(domainMemberships.status, "active"),
    ),
  ).where(eq(domains.slug, DEFAULT_DOMAIN_SLUG)).limit(1);
  if (!row) return new Set();
  const role = resolveEffectiveDomainRole(
    userId,
    { owner_id: row.owner_id },
    row.role ? { role: row.role } : null,
  );
  return domainRoleCapabilities(role);
}

/** 读取（并缓存）当前请求的平台角色。 */
export async function resolvePlatformRole(
  c: Context,
): Promise<PlatformRole | null> {
  const cached = (c as unknown as RoleCacheCarrier)[PLATFORM_ROLE_CACHE];
  if (cached) return cached;
  const userId = c.get("userId") as string | undefined;
  if (!userId) return null;
  const role = await findPlatformRole(userId);
  if (role) (c as unknown as RoleCacheCarrier)[PLATFORM_ROLE_CACHE] = role;
  return role;
}

/** 当前请求用户是否平台管理员（请求级缓存）。 */
export async function isCurrentUserAdmin(c: Context): Promise<boolean> {
  return (await resolvePlatformRole(c)) === "admin";
}

/** 当前请求用户的能力集合（请求级缓存）。 */
export async function resolvePermissions(
  c: Context,
): Promise<ReadonlySet<CapabilityName>> {
  const cached = c.get("userPerms") as
    | ReadonlySet<CapabilityName>
    | undefined;
  if (cached) return cached;
  const role = await resolvePlatformRole(c);
  const platform = role
    ? platformRoleCapabilities(role)
    : new Set<CapabilityName>();
  const domain = await resolveMainDomainCapabilities(
    c.get("userId") as string | undefined,
  );
  const capabilities = new Set<CapabilityName>([...platform, ...domain]);
  c.set("userPerms", capabilities as never);
  return capabilities;
}

/** handler 内条件判断：是否具备某能力。 */
export async function checkPermission(
  c: Context,
  permission: CapabilityName,
): Promise<boolean> {
  return (await resolvePermissions(c)).has(permission);
}

/** handler 内断言：无能力时抛 403。 */
export async function assertPermission(
  c: Context,
  permission: CapabilityName,
): Promise<void> {
  if (!(await checkPermission(c, permission))) {
    throw new ForbiddenError("权限不足");
  }
}

/** 管理路由中间件：平台角色必须为 admin。 */
export function requireAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!c.get("userId")) throw new UnauthorizedError("未提供认证令牌");
    if ((await resolvePlatformRole(c)) !== "admin") {
      throw new ForbiddenError("需要管理员权限");
    }
    await next();
  };
}

/** 通用能力中间件：平台角色能力集合必须包含该能力。 */
export function requirePermission(
  permission: CapabilityName,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!(await checkPermission(c, permission))) {
      throw new ForbiddenError("权限不足");
    }
    await next();
  };
}
