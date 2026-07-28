/**
 * RBAC 权限检查模块。
 *
 * 核心函数：
 * - getUserPermissions(userId) — 递归 CTE 查询用户所有权限，返回 Set<string>
 * - checkPermission(c, permission) — isAdmin fast path → Set.has()
 * - assertPermission(c, permission) — 同上但无权限时抛 ForbiddenError
 * - resolvePermissions(c) — 请求级缓存
 * - requireAdmin() — 纯 JWT fast path 中间件
 * - requirePermission(permission) — 通用权限中间件
 */

import { sql } from "drizzle-orm";
import { Context, MiddlewareHandler, Next } from "hono";
import { getDb } from "../db/connection.ts";
import { ForbiddenError } from "./errors.ts";
import { unwrapRows } from "./sql-rows.ts";

// ── 数据库查询（只有这个函数访问 DB）──────────────────────

export async function getUserPermissions(userId: string): Promise<Set<string>> {
  const db = getDb();

  const result = await db.execute<{ perm: string }>(sql`
    WITH RECURSIVE resolved AS (
      SELECT r.id, r.is_admin, r.parent_id
      FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ${userId}
      UNION ALL
      SELECT r.id, r.is_admin, r.parent_id
      FROM roles r
      JOIN resolved rr ON r.id = rr.parent_id
    )
    SELECT DISTINCT p.resource || ':' || p.action AS perm
    FROM resolved rr
    JOIN role_permissions rp ON rp.role_id = rr.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rr.is_admin = false
  `);

  const rows = unwrapRows<{ perm: string }>(result as never);
  return new Set(rows.map((r) => r.perm));
}

// ── 请求级缓存 ────────────────────────────────────────────

export async function resolvePermissions(c: Context): Promise<Set<string>> {
  let perms = c.get("userPerms") as Set<string> | undefined;
  if (perms) return perms;

  perms = await getUserPermissions(c.var.userId as string);
  c.set("userPerms", perms);
  return perms;
}

// ── 工具函数（handler / service 内部使用）──────────────────

export async function checkPermission(
  c: Context,
  permission: string,
): Promise<boolean> {
  if (c.var.isAdmin === true) return true;
  const perms = await resolvePermissions(c);
  return perms.has(permission);
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
 * 管理路由中间件：纯 JWT fast path，零 DB 查询。
 * 替代原 adminMiddleware。基于 c.var.isAdmin 判断。
 */
export function requireAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!c.var.isAdmin) {
      throw new ForbiddenError("需要管理员权限");
    }
    await next();
  };
}

/**
 * 通用权限中间件工厂函数。
 * - isAdmin 用户 → 直接放行（fast path，零 DB 查询）
 * - 否则 → 查 DB 获取权限 Set，检查 Set.has(permission)
 *
 * 同一请求内多次 requirePermission 调用共享 resolvePermissions 的请求级缓存。
 */
export function requirePermission(permission: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (c.var.isAdmin === true) {
      await next();
      return;
    }

    const perms = await resolvePermissions(c);
    if (!perms.has(permission)) {
      throw new ForbiddenError("权限不足");
    }

    await next();
  };
}
