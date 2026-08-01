/**
 * RBAC 种子数据初始化。
 *
 * 包含：
 * - ensureSystemRoles() — 创建预置角色（admin, user）
 * - ensurePermissions() — 创建 22 个系统权限定义
 * - ensureUserRolePermissions() — 为 user 角色分配默认权限
 * - migrateExistingUsers() — 将现有 users.role 同步到 user_roles 表
 * - ensureRbacSeeds() — 全量幂等初始化
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "../db/schema.ts";
import { PERMISSION_DEFS } from "../types/index.ts";
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

// admin 角色的默认权限（action 列表）：社区治理与板块管理
// （admin 有 is_admin fast path，显式授予便于角色权限表展示与继承）
const ADMIN_DEFAULT_PERMISSIONS: Array<{ resource: string; action: string }> = [
  { resource: "community_moderation", action: "review" },
  { resource: "community_moderation", action: "hide" },
  { resource: "community_moderation", action: "lock" },
  { resource: "community_moderation", action: "sanction" },
  { resource: "community_board", action: "manage" },
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
    is_admin: true,
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
    is_admin: false,
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

export async function migrateExistingUsers(): Promise<void> {
  const db = getDb();

  const allUsers = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(sql`${users.id} <> '0'`);

  const roleRows = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles);
  const roleIdByName = new Map(roleRows.map((r) => [r.name, r.id]));

  for (const u of allUsers) {
    const targetRoleId = u.role === "admin"
      ? roleIdByName.get(ROLE_ADMIN)
      : roleIdByName.get(ROLE_USER);
    if (!targetRoleId) continue;
    await db.insert(userRoles).values({
      user_id: u.id,
      role_id: targetRoleId,
    }).onConflictDoNothing();
  }
}

/**
 * 全量幂等初始化。应在启动期（migration 后）或 seed 时调用。
 */
export async function ensureRbacSeeds(): Promise<void> {
  await ensureSystemRoles();
  await ensurePermissions();
  await ensureUserRolePermissions();
  await ensureAdminRolePermissions();
  await migrateExistingUsers();
  await ensureCommunitySeeds();
}
