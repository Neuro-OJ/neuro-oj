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

// ── 权限定义 ──────────────────────────────────────────────
interface PermissionDef {
  resource: string;
  action: string;
  description: string;
}

const PERMISSION_DEFS: PermissionDef[] = [
  // 题目
  { resource: "problem", action: "create", description: "创建题目" },
  {
    resource: "problem",
    action: "create_p",
    description: "创建管理题（P 型）",
  },
  { resource: "problem", action: "read", description: "查看题目" },
  { resource: "problem", action: "write_own", description: "编辑自己的题目" },
  { resource: "problem", action: "write_any", description: "编辑任意题目" },
  { resource: "problem", action: "delete_own", description: "删除自己的题目" },
  { resource: "problem", action: "delete_any", description: "删除任意题目" },
  {
    resource: "problem",
    action: "package_manage_own",
    description: "管理自己题目的支持包",
  },
  {
    resource: "problem",
    action: "package_manage_any",
    description: "管理任意题目的支持包",
  },
  // 提交
  { resource: "submission", action: "create", description: "创建提交" },
  { resource: "submission", action: "read_own", description: "查看自己的提交" },
  {
    resource: "submission",
    action: "read_all",
    description: "查看所有提交（含代码）",
  },
  { resource: "submission", action: "rejudge", description: "触发重测" },
  // 用户
  { resource: "user", action: "read_profile", description: "查看用户主页" },
  { resource: "user", action: "search", description: "搜索用户" },
  {
    resource: "user",
    action: "manage",
    description: "管理用户（封禁/改角色）",
  },
  // 分类
  { resource: "category", action: "read", description: "查看分类" },
  { resource: "category", action: "manage", description: "管理分类" },
  // 系统
  { resource: "system", action: "settings", description: "系统设置" },
  { resource: "system", action: "judge_images", description: "管理评测镜像" },
  { resource: "system", action: "audit_logs", description: "查看审计日志" },
  { resource: "system", action: "ip_bans", description: "管理 IP 黑名单" },
];

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
  await migrateExistingUsers();
}
