/**
 * RBAC 种子数据初始化。
 *
 * 包含：
 * - ensureSystemRoles() — 创建预置角色（admin, user）
 * - ensurePermissions() — 创建系统权限定义（PERMISSION_DEFS）
 * - ensureUserRolePermissions() — 为 user 角色分配默认权限
 * - ensureSensitiveFieldDefaultPermissions() — 敏感字段权限项一次性默认撤销
 * - migrateExistingUsers() — 将现有 users.role 同步到 user_roles 表
 * - ensureRbacSeeds() — 全量幂等初始化
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  permissions,
  rolePermissions,
  roles,
  systemSettings,
  userRoles,
  users,
} from "../db/schema.ts";
import { PERMISSION_DEFS } from "../types/index.ts";
import { ROOT_USER_ID } from "../lib/constants.ts";
import { ensureCommunitySeeds } from "./community-seed.ts";

// user 角色的默认权限（action 列表）
const USER_DEFAULT_PERMISSIONS: Array<{ resource: string; action: string }> = [
  { resource: "problem", action: "create" },
  { resource: "problem", action: "read" },
  { resource: "problem", action: "write_own" },
  { resource: "problem", action: "delete_own" },
  { resource: "problem", action: "package_manage_own" },
  { resource: "submission", action: "create" },
  { resource: "submission", action: "read_own" },
  { resource: "user", action: "read_profile" },
  { resource: "category", action: "read" },
  { resource: "contest", action: "participate" },
  { resource: "community", action: "read" },
  { resource: "community", action: "create_solution" },
  { resource: "community", action: "create_discussion" },
  { resource: "community", action: "create_moment" },
  { resource: "community", action: "comment" },
  { resource: "community", action: "react" },
  { resource: "community", action: "follow" },
  { resource: "community", action: "report" },
];

// NOJ-062：普通注册用户不得默认持有 evaluator.command/network 等敏感字段
// 修改权限。升级时从 user 角色撤销一次；之后管理员可以显式在 RBAC 面板中
// 重新授权，重启不会被 seed 再次撤销。管理员角色通过 admin:full_access 通配放行。
const SENSITIVE_FIELD_REVOKE_PERMISSIONS: Array<{
  resource: string;
  action: string;
}> = [
  { resource: "problem", action: "field_evaluator_command" },
  { resource: "problem", action: "field_evaluator_network" },
];

/** 敏感字段权限已按 NOJ-062 撤销过一轮的内部标记（不注册进 settings-registry）。 */
const SENSITIVE_FIELD_REVOKE_SEED_KEY =
  "rbac_sensitive_field_permissions_revoked";

// admin 角色的默认权限（action 列表）：admin:full_access 全权限 + 社区治理与板块管理
// （admin:full_access 为管理员判定权限，权限检查时通配放行一切权限）
const ADMIN_DEFAULT_PERMISSIONS: Array<{ resource: string; action: string }> = [
  { resource: "admin", action: "full_access" },
  { resource: "community_moderation", action: "review" },
  { resource: "community_moderation", action: "hide" },
  { resource: "community_moderation", action: "lock" },
  { resource: "community_moderation", action: "sanction" },
  { resource: "community_board", action: "manage" },
  { resource: "announcement", action: "manage" },
];

// ── 工具 ──────────────────────────────────────────────────
function uuid(): string {
  return crypto.randomUUID() as string;
}

function now(): string {
  return new Date().toISOString();
}

// ── 系统角色名常量 ────────────────────────────────────────
const ROLE_ADMIN = "admin";
const ROLE_USER = "user";

// ── 公开 API ─────────────────────────────────────────────

export async function ensureSystemRoles(): Promise<void> {
  const db = getDb();

  await db.insert(roles).values({
    id: ROLE_ADMIN,
    name: ROLE_ADMIN,
    description: "系统管理员",
    is_system: true,
    is_default: false,
    parent_id: null,
    created_at: now(),
    updated_at: now(),
  }).onConflictDoNothing({ target: roles.name });

  await db.insert(roles).values({
    id: ROLE_USER,
    name: ROLE_USER,
    description: "普通用户",
    is_system: true,
    is_default: true,
    parent_id: null,
    created_at: now(),
    updated_at: now(),
  }).onConflictDoNothing({ target: roles.name });
}

export async function ensurePermissions(): Promise<void> {
  const db = getDb();

  for (const perm of PERMISSION_DEFS) {
    await db.insert(permissions).values({
      id: uuid(),
      resource: perm.resource,
      action: perm.action,
      description: perm.description,
    }).onConflictDoNothing({
      target: [permissions.resource, permissions.action],
    });
  }
}

export async function ensureUserRolePermissions(): Promise<void> {
  const db = getDb();

  const [userRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ROLE_USER))
    .limit(1);
  if (!userRole) return;

  const allPerms = await db
    .select({
      id: permissions.id,
      resource: permissions.resource,
      action: permissions.action,
    })
    .from(permissions);

  const permMap = new Map(
    allPerms.map((p) => [`${p.resource}:${p.action}`, p.id]),
  );

  for (const { resource, action } of USER_DEFAULT_PERMISSIONS) {
    const permId = permMap.get(`${resource}:${action}`);
    if (!permId) continue;
    await db.insert(rolePermissions).values({
      role_id: userRole.id,
      permission_id: permId,
    }).onConflictDoNothing();
  }
}

export async function ensureAdminRolePermissions(): Promise<void> {
  const db = getDb();

  const [adminRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ROLE_ADMIN))
    .limit(1);
  if (!adminRole) return;

  const allPerms = await db
    .select({
      id: permissions.id,
      resource: permissions.resource,
      action: permissions.action,
    })
    .from(permissions);

  const permMap = new Map(
    allPerms.map((p) => [`${p.resource}:${p.action}`, p.id]),
  );

  for (const { resource, action } of ADMIN_DEFAULT_PERMISSIONS) {
    const permId = permMap.get(`${resource}:${action}`);
    if (!permId) continue;
    await db.insert(rolePermissions).values({
      role_id: adminRole.id,
      permission_id: permId,
    }).onConflictDoNothing();
  }
}

/**
 * 为尚无任何 user_roles 关联的存量用户补齐默认 user 角色。
 * （users.role 列已废弃删除；历史迁移过的数据不受影响）
 */
export async function migrateExistingUsers(): Promise<void> {
  const db = getDb();

  const allUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.id} <> '0'`);

  const [userRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ROLE_USER))
    .limit(1);
  if (!userRole || allUsers.length === 0) return;

  const existingRows = await db
    .select({ user_id: userRoles.user_id })
    .from(userRoles);
  const existingIds = new Set(existingRows.map((r) => r.user_id));

  for (const u of allUsers) {
    if (existingIds.has(u.id)) continue;
    await db.insert(userRoles).values({
      user_id: u.id,
      role_id: userRole.id,
    }).onConflictDoNothing();
  }
}

/**
 * NOJ-062：敏感字段权限从 user 角色撤销一次。
 *
 * 升级/初始化时执行一次撤销，之后写入 system_settings 内部标记；
 * 管理员后续在 RBAC 面板中给 user 角色重新授权后，重启不会被本函数再次撤销。
 *
 * 直接读写 system_settings 表（不走 settings 服务层缓存）：本函数在启动期
 * ensureRbacSeeds 中调用，此时 settings 缓存尚未初始化（main.ts 顺序）。
 */
export async function ensureSensitiveFieldDefaultPermissions(): Promise<void> {
  const db = getDb();

  const [userRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, ROLE_USER))
    .limit(1);
  if (!userRole) return;

  const [marker] = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, SENSITIVE_FIELD_REVOKE_SEED_KEY))
    .limit(1);
  if (marker) return;

  const allPerms = await db
    .select({
      id: permissions.id,
      resource: permissions.resource,
      action: permissions.action,
    })
    .from(permissions);
  const permMap = new Map(
    allPerms.map((p) => [`${p.resource}:${p.action}`, p.id]),
  );

  for (const { resource, action } of SENSITIVE_FIELD_REVOKE_PERMISSIONS) {
    const permId = permMap.get(`${resource}:${action}`);
    if (!permId) continue;
    await db.delete(rolePermissions).where(
      and(
        eq(rolePermissions.role_id, userRole.id),
        eq(rolePermissions.permission_id, permId),
      ),
    );
  }

  const now = new Date().toISOString();
  await db.insert(systemSettings).values({
    key: SENSITIVE_FIELD_REVOKE_SEED_KEY,
    value: "1",
    description: "内部：NOJ-062 敏感字段默认权限已撤销（勿手动修改）",
    is_secret: false,
    updated_at: now,
    updated_by: ROOT_USER_ID,
  }).onConflictDoNothing();
}

/**
 * 全量幂等初始化。应在启动期（migration 后）或 seed 时调用。
 */
export async function ensureRbacSeeds(): Promise<void> {
  await ensureSystemRoles();
  await ensurePermissions();
  await ensureUserRolePermissions();
  await ensureSensitiveFieldDefaultPermissions();
  await ensureAdminRolePermissions();
  await migrateExistingUsers();
  await ensureCommunitySeeds();
}
