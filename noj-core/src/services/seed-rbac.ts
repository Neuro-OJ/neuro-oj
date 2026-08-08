/**
 * RBAC 种子数据初始化。
 *
 * 包含：
 * - ensureSystemRoles() — 创建预置角色（admin, user）
 * - ensurePermissions() — 创建系统权限定义（PERMISSION_DEFS）
 * - ensureUserRolePermissions() — 为 user 角色分配默认权限
 * - ensureSensitiveFieldDefaultPermissions() — 敏感字段权限项一次性默认授权
 * - migrateExistingUsers() — 将现有 users.role 同步到 user_roles 表
 * - ensureRbacSeeds() — 全量幂等初始化
 */

import { eq, sql } from "drizzle-orm";
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

// 敏感字段权限项的默认授权（issue #207）。
// 注意：**不在** USER_DEFAULT_PERMISSIONS 中——它的默认授权是**一次性**的：
// 首次 seed 时补齐，之后管理员从 user 角色移除授权（收紧）后，重启不会被
// 恢复。已 seed 的权限清单记录在 system_settings 内部标记
// `rbac_sensitive_field_permissions_seeded`（JSON 数组，不注册、不展示）。
// 未来新增敏感字段权限：加入此列表即可，首次 seed 自动补齐默认授权。
const SENSITIVE_FIELD_DEFAULT_PERMISSIONS: Array<{
  resource: string;
  action: string;
}> = [
  { resource: "problem", action: "field_evaluator_command" },
  { resource: "problem", action: "field_evaluator_network" },
];

/** 敏感字段默认授权 seed 标记（system_settings 内部 key，不注册进 registry） */
const SENSITIVE_FIELD_SEED_KEY = "rbac_sensitive_field_permissions_seeded";

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
 * 敏感字段权限项的一次性默认授权（issue #207）。
 *
 * 与 USER_DEFAULT_PERMISSIONS 的"每次幂等补齐"不同：仅在权限项首次出现时
 * 授予 user 角色（默认放行），之后管理员从角色移除授权（收紧）后**重启不会
 * 被恢复**。已 seed 的权限清单存于 system_settings 内部标记
 * `rbac_sensitive_field_permissions_seeded`（JSON 数组，key 不注册进
 * settings-registry，不在管理后台展示、不可经 API 修改）。
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

  // 读取已 seed 标记（JSON 数组）
  const seededRows = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, SENSITIVE_FIELD_SEED_KEY))
    .limit(1);
  let seeded = new Set<string>();
  if (seededRows.length > 0) {
    try {
      const parsed = JSON.parse(seededRows[0].value);
      if (Array.isArray(parsed)) seeded = new Set(parsed.map(String));
    } catch {
      // 标记损坏时按空处理（重新补齐一次，幂等）
    }
  }

  const newlySeeded: string[] = [];
  for (const { resource, action } of SENSITIVE_FIELD_DEFAULT_PERMISSIONS) {
    const key = `${resource}:${action}`;
    if (seeded.has(key)) continue; // 已 seed 过：管理员移除授权不恢复
    const permId = permMap.get(key);
    if (!permId) continue; // 权限项缺失（PERMISSION_DEFS 未含）时跳过
    await db.insert(rolePermissions).values({
      role_id: userRole.id,
      permission_id: permId,
    }).onConflictDoNothing();
    seeded.add(key);
    newlySeeded.push(key);
  }

  // 有新增时更新标记（幂等 upsert）
  if (newlySeeded.length > 0) {
    const nowIso = new Date().toISOString();
    await db.insert(systemSettings).values({
      key: SENSITIVE_FIELD_SEED_KEY,
      value: JSON.stringify([...seeded]),
      description: "内部：已默认授权的敏感字段权限（勿手动修改）",
      is_secret: false,
      updated_at: nowIso,
      updated_by: ROOT_USER_ID,
    }).onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify([...seeded]),
        updated_at: nowIso,
        updated_by: ROOT_USER_ID,
      },
    });
  }
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
