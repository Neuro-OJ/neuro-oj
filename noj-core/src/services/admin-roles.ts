/**
 * 管理员角色管理服务。
 *
 * 提供角色 CRUD、权限列表查询、用户角色分配等功能。
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { roles, permissions, rolePermissions, userRoles, users } from "../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.ts";
import { logger } from "../lib/logging.ts";

function uuid(): string {
  return crypto.randomUUID() as string;
}

function now(): string {
  return new Date().toISOString();
}

interface RoleResponse {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  is_default: boolean;
  is_admin: boolean;
  parent_id: string | null;
  parent_name: string | null;
  permissions: Array<{ id: string; resource: string; action: string; description: string }>;
}

interface PermissionResponse {
  id: string;
  resource: string;
  action: string;
  description: string;
}

// ── 角色列表 ─────────────────────────────────────────────

export async function listRoles(): Promise<RoleResponse[]> {
  const db = getDb();

  const roleRows = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      is_system: roles.is_system,
      is_default: roles.is_default,
      is_admin: roles.is_admin,
      parent_id: roles.parent_id,
      parent_name: sql<string>`parent.name`,
    })
    .from(roles)
    .leftJoin(sql`roles parent`, sql`parent.id = ${roles.parent_id}`)
    .orderBy(roles.name);

  const result: RoleResponse[] = [];

  for (const row of roleRows) {
    const perms = await db
      .select({
        id: permissions.id,
        resource: permissions.resource,
        action: permissions.action,
        description: permissions.description,
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permission_id))
      .where(eq(rolePermissions.role_id, row.id));

    result.push({
      id: row.id,
      name: row.name,
      description: row.description,
      is_system: row.is_system,
      is_default: row.is_default,
      is_admin: row.is_admin,
      parent_id: row.parent_id,
      parent_name: row.parent_name ?? null,
      permissions: perms,
    });
  }

  return result;
}

// ── 创建角色 ─────────────────────────────────────────────

export async function createRole(data: {
  name: string;
  description?: string;
  parent_id?: string;
  permission_ids?: string[];
}): Promise<RoleResponse> {
  const db = getDb();

  if (!data.name || data.name.trim().length === 0) {
    throw new BadRequestError("角色名称不能为空");
  }

  // 检查名称唯一性
  const existing = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, data.name.trim()))
    .limit(1);

  if (existing.length > 0) {
    throw new ConflictError("角色名已存在");
  }

  // 验证 parent_id 有效
  if (data.parent_id) {
    const parent = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, data.parent_id))
      .limit(1);
    if (parent.length === 0) {
      throw new BadRequestError("父角色不存在");
    }

    // 循环继承检测
    if (await wouldCreateCycle(data.parent_id, data.parent_id)) {
      throw new BadRequestError("角色继承关系存在循环引用");
    }
  }

  const id = uuid();
  const timestamp = now();

  await db.insert(roles).values({
    id,
    name: data.name.trim(),
    description: data.description?.trim() ?? "",
    is_system: false,
    is_default: false,
    is_admin: false,
    parent_id: data.parent_id ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  });

  // 分配权限
  if (data.permission_ids && data.permission_ids.length > 0) {
    // 验证权限 ID 有效
    const validPerms = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.id, data.permission_ids));

    const validIds = new Set(validPerms.map(p => p.id));

    for (const permId of data.permission_ids) {
      if (!validIds.has(permId)) continue;
      await db.insert(rolePermissions).values({
        role_id: id,
        permission_id: permId,
      }).onConflictDoNothing();
    }
  }

  return (await getRoleById(id))!;
}

// ── 编辑角色 ─────────────────────────────────────────────

export async function updateRole(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null; permission_ids?: string[] },
): Promise<RoleResponse> {
  const db = getDb();

  const existing = await db
    .select()
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("角色不存在");
  }

  const role = existing[0];

  // 系统角色限制
  if (role.is_system) {
    if (data.name !== undefined && data.name !== role.name) {
      throw new ForbiddenError("系统角色的名称不可修改");
    }
  }

  const updates: Record<string, unknown> = { updated_at: now() };

  if (data.name !== undefined && data.name.trim()) {
    // 检查名称唯一性（排除自身）
    const dup = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, data.name.trim()), ne(roles.id, id)))
      .limit(1);
    if (dup.length > 0) {
      throw new ConflictError("角色名已存在");
    }
    updates.name = data.name.trim();
  }

  if (data.description !== undefined) {
    updates.description = data.description.trim();
  }

  if (data.parent_id !== undefined) {
    if (data.parent_id === id) {
      throw new BadRequestError("角色不能继承自身");
    }

    if (data.parent_id !== null) {
      const parent = await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, data.parent_id))
        .limit(1);
      if (parent.length === 0) {
        throw new BadRequestError("父角色不存在");
      }

      if (await wouldCreateCycle(data.parent_id, data.parent_id, id)) {
        throw new BadRequestError("角色继承关系存在循环引用");
      }
    }
    updates.parent_id = data.parent_id;
  }

  if (Object.keys(updates).length > 1) { // more than just updated_at
    await db.update(roles)
      .set(updates)
      .where(eq(roles.id, id));
  }

  // 更新权限
  if (data.permission_ids !== undefined) {
    // 删除所有旧权限
    await db.delete(rolePermissions)
      .where(eq(rolePermissions.role_id, id));

    // 插入新权限
    for (const permId of data.permission_ids) {
      await db.insert(rolePermissions).values({
        role_id: id,
        permission_id: permId,
      }).onConflictDoNothing();
    }
  }

  return (await getRoleById(id))!;
}

// ── 删除角色 ─────────────────────────────────────────────

export async function deleteRole(id: string): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("角色不存在");
  }

  const role = existing[0];

  if (role.is_system) {
    throw new ForbiddenError("系统角色不可删除");
  }

  // 检查是否有其他角色继承了此角色
  const children = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.parent_id, id))
    .limit(1);

  if (children.length > 0) {
    throw new BadRequestError(
      `角色 "${role.name}" 被角色 "${children[0].name}" 继承，无法删除`,
    );
  }

  // 级联删除：CASCADE 自动清理 role_permissions 和 user_roles
  await db.delete(roles).where(eq(roles.id, id));
}

// ── 权限列表 ─────────────────────────────────────────────

export async function listPermissions(): Promise<Record<string, PermissionResponse[]>> {
  const db = getDb();

  const rows = await db
    .select()
    .from(permissions)
    .orderBy(permissions.resource, permissions.action);

  const grouped: Record<string, PermissionResponse[]> = {};
  for (const row of rows) {
    if (!grouped[row.resource]) grouped[row.resource] = [];
    grouped[row.resource].push({
      id: row.id,
      resource: row.resource,
      action: row.action,
      description: row.description,
    });
  }

  return grouped;
}

// ── 用户角色分配 ─────────────────────────────────────────

export async function updateUserRoles(
  targetUserId: string,
  roleIds: string[],
  currentUserId: string,
): Promise<void> {
  const db = getDb();

  if (targetUserId === currentUserId) {
    throw new BadRequestError("不能修改自己的角色");
  }

  if (targetUserId === "0") {
    throw new BadRequestError("不能修改 root 用户的角色");
  }

  // 验证目标用户存在
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (user.length === 0) {
    throw new NotFoundError("用户不存在");
  }

  // 验证所有角色 ID 有效
  if (roleIds.length === 0) {
    throw new BadRequestError("用户必须至少拥有一个角色");
  }

  const validRoles = await db
    .select({ id: roles.id, is_admin: roles.is_admin })
    .from(roles)
    .where(inArray(roles.id, roleIds));

  const validIdSet = new Set(validRoles.map(r => r.id));
  const invalidIds = roleIds.filter(rid => !validIdSet.has(rid));
  if (invalidIds.length > 0) {
    throw new BadRequestError(`无效的角色 ID: ${invalidIds.join(", ")}`);
  }

  const newRolesAreAdmin = validRoles.some(r => r.is_admin);

  // 如果正在移除 admin 标记，检查是否为最后一个 admin
  // 该用户的当前角色
  const currentRoles = await db
    .select({ is_admin: roles.is_admin })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id))
    .where(eq(userRoles.user_id, targetUserId));

  const currentlyAdmin = currentRoles.some(r => r.is_admin);

  if (currentlyAdmin && !newRolesAreAdmin) {
    // 正在移除该用户的 admin 角色
    const adminCount = await db.execute(sql`
      SELECT COUNT(DISTINCT ur.user_id)::int AS count
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE r.is_admin = true
        AND ur.user_id != ${targetUserId}
        AND ur.user_id != '0'
    `);

    // deno-lint-ignore no-explicit-any
    const count = Number((adminCount as any)[0]?.count ?? 0);
    if (count === 0) {
      throw new BadRequestError("至少保留一个管理员");
    }
  }

  // 替换所有角色
  await db.delete(userRoles)
    .where(eq(userRoles.user_id, targetUserId));

  for (const roleId of roleIds) {
    await db.insert(userRoles).values({
      user_id: targetUserId,
      role_id: roleId,
    }).onConflictDoNothing();
  }
}

// ── 辅助函数 ─────────────────────────────────────────────

async function getRoleById(id: string): Promise<RoleResponse | null> {
  const db = getDb();

  const rows = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      is_system: roles.is_system,
      is_default: roles.is_default,
      is_admin: roles.is_admin,
      parent_id: roles.parent_id,
      parent_name: sql<string | null>`NULL`,
    })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // 查询父角色名
  if (row.parent_id) {
    const parent = await db
      .select({ name: roles.name })
      .from(roles)
      .where(eq(roles.id, row.parent_id))
      .limit(1);
    row.parent_name = parent[0]?.name ?? null;
  }

  const perms = await db
    .select({
      id: permissions.id,
      resource: permissions.resource,
      action: permissions.action,
      description: permissions.description,
    })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permission_id))
    .where(eq(rolePermissions.role_id, id));

  return {
    ...row,
    description: row.description,
    permissions: perms,
  };
}

/**
 * 检测角色继承是否会导致循环引用。
 * 从 startId 向上遍历 parent_id 链，看是否回到给定的 roleId。
 */
async function wouldCreateCycle(
  startId: string,
  checkId: string,
  excludeId?: string,
): Promise<boolean> {
  const db = getDb();
  let currentId = startId;
  const visited = new Set<string>();

  while (currentId) {
    if (excludeId && currentId === excludeId) {
      // Don't check the excluded role in cycle detection
      // (it's the one being updated, we need to skip its current parent)
    }
    if (currentId === checkId && currentId !== startId) return true;
    if (visited.has(currentId)) return false; // shouldn't happen, but guard

    visited.add(currentId);

    const rows = await db
      .select({ parent_id: roles.parent_id })
      .from(roles)
      .where(eq(roles.id, currentId))
      .limit(1);

    if (rows.length === 0 || !rows[0].parent_id) break;
    currentId = rows[0].parent_id;
  }

  return false;
}
