/**
 * RBAC 权限检查模块。
 *
 * 核心函数：
 * - getUserPermissions(userId) — 递归 CTE 查询用户所有权限（含角色继承链），返回 Set<string>
 * - checkPermission(c, permission) — admin:full_access 通配放行 → Set.has()
 * - assertPermission(c, permission) — 同上但无权限时抛 ForbiddenError
 * - resolvePermissions(c) — 请求级缓存
 * - requireAdmin() — 实时权限查询的管理员中间件
 * - requirePermission(permission) — 通用权限中间件
 *
 * 管理员语义：用户权限集（含继承链）包含 `admin:full_access` 权限即视为管理员，
 * 对任意权限检查直接放行。JWT 不携带 is_admin claim，判定实时查询。
 */

import { sql } from "drizzle-orm";
import { Context, MiddlewareHandler, Next } from "hono";
import { getDb } from "../db/connection.ts";
import { ForbiddenError } from "./../shared/base/errors.ts";
import { unwrapRows } from "./../shared/base/sql-rows.ts";

/** 全权限通行证权限（resource:action） */
export const ADMIN_FULL_ACCESS = "admin:full_access";

// ── 数据库查询（只有这个函数访问 DB）──────────────────────

export async function getUserPermissions(userId: string): Promise<Set<string>> {
  const db = getDb();

  const result = await db.execute<{ perm: string }>(sql`
    WITH RECURSIVE resolved AS (
      SELECT r.id, r.parent_id
      FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ${userId}
      UNION ALL
      SELECT r.id, r.parent_id
      FROM roles r
      JOIN resolved rr ON r.id = rr.parent_id
    )
    SELECT DISTINCT p.resource || ':' || p.action AS perm
    FROM resolved rr
    JOIN role_permissions rp ON rp.role_id = rr.id
    JOIN permissions p ON p.id = rp.permission_id
  `);

  const rows = unwrapRows<{ perm: string }>(result as never);
  return new Set(rows.map((r) => r.perm));
}

/**
 * 单用户管理员判定（含角色继承链）：权限集是否包含 admin:full_access。
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  const perms = await getUserPermissions(userId);
  return perms.has(ADMIN_FULL_ACCESS);
}

/**
 * 查询所有拥有 admin:full_access 权限（含角色继承链）的用户 id 集合。
 * 供 admin 列表展示 / is_admin 筛选 / 封禁保护等批量场景使用，避免 N+1。
 */
export async function getAdminUserIds(): Promise<Set<string>> {
  const db = getDb();

  const result = await db.execute<{ user_id: string }>(sql`
    WITH RECURSIVE resolved AS (
      SELECT ur.user_id, r.id, r.parent_id
      FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      UNION ALL
      SELECT rr.user_id, r.id, r.parent_id
      FROM roles r
      JOIN resolved rr ON r.id = rr.parent_id
    )
    SELECT DISTINCT rr.user_id
    FROM resolved rr
    JOIN role_permissions rp ON rp.role_id = rr.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.resource = 'admin' AND p.action = 'full_access'
  `);

  const rows = unwrapRows<{ user_id: string }>(result as never);
  return new Set(rows.map((r) => r.user_id));
}

// ── 请求级缓存 ────────────────────────────────────────────

export async function resolvePermissions(c: Context): Promise<Set<string>> {
  // 匿名（optionalAuthMiddleware 未登录）时权限集为空，避免 undefined userId 查询报错
  const userId = c.var.userId as string | undefined;
  if (!userId) return new Set();

  let perms = c.get("userPerms") as Set<string> | undefined;
  if (perms) return perms;

  perms = await getUserPermissions(userId);
  c.set("userPerms", perms);
  return perms;
}

// ── 工具函数（handler / service 内部使用）──────────────────

export async function checkPermission(
  c: Context,
  permission: string,
): Promise<boolean> {
  const perms = await resolvePermissions(c);
  return perms.has(ADMIN_FULL_ACCESS) || perms.has(permission);
}

export async function assertPermission(
  c: Context,
  permission: string,
): Promise<void> {
  if (!(await checkPermission(c, permission))) {
    throw new ForbiddenError("权限不足");
  }
}

// ── 中间件 ────────────────────────────────────────────────

/**
 * 管理路由中间件：基于实时权限查询判断（请求级缓存，一请求只查一次 DB）。
 * 替代原基于 JWT is_admin claim 的 fast path。
 */
export function requireAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const perms = await resolvePermissions(c);
    if (!perms.has(ADMIN_FULL_ACCESS)) {
      throw new ForbiddenError("需要管理员权限");
    }
    await next();
  };
}

/**
 * 通用权限中间件工厂函数。
 * - 权限集含 admin:full_access → 直接放行（通配）
 * - 否则 → 检查 Set.has(permission)
 *
 * 同一请求内多次 requirePermission 调用共享 resolvePermissions 的请求级缓存。
 */
export function requirePermission(permission: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const perms = await resolvePermissions(c);
    if (!perms.has(ADMIN_FULL_ACCESS) && !perms.has(permission)) {
      throw new ForbiddenError("权限不足");
    }
    await next();
  };
}
