/**
 * RBAC 种子数据初始化。
 *
 * 包含：
 * - ensureSystemRoles() — 创建预置角色（admin, user）
 * - ensurePermissions() — 创建系统权限定义并同步描述（PERMISSION_DEFS）
 * - ensureUserRolePermissions() — 为 user 角色分配默认权限
 * - ensureSensitiveFieldDefaultPermissions() — 敏感字段权限项一次性默认撤销
 * - migrateExistingUsers() — 将现有 users.role 同步到 user_roles 表
 * - ensureRbacSeeds() — 全量幂等初始化
 *
 * 写入策略（P3 测试提速）：固定集合一律走一次批量语句，去掉逐条往返。
 * 批量写法必须保持原有语义：
 * - 权限按 (resource, action) 冲突只同步 description，保留原 ID；描述未变不更新；
 * - 角色按现有 name 复用真实 ID（运维可能用自定义 UUID 建过同名角色）；
 * - 目标集合为空时直接跳过，不发无效 INSERT；
 * - 敏感权限撤销只在标记缺失时发生一次，管理员后续显式授权不被覆盖。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import {
  permissions,
  rolePermissions,
  roles,
  systemSettings,
  userRoles,
  users,
} from "../../../../../shared/db/schema.ts";
import { PERMISSION_DEFS } from "../../../../access/identity/types/permissions.ts";
import { ROOT_USER_ID } from "../../../../../shared/base/constants.ts";
import { ensureCommunitySeeds } from "../../../../communication/contracts/cross-module/community_services_community_community-seed.ts";

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
  { resource: "tag", action: "read" },
  { resource: "contest", action: "create" },
  { resource: "contest", action: "participate" },
  { resource: "community", action: "read" },
  { resource: "community", action: "create_solution" },
  { resource: "community", action: "create_discussion" },
  { resource: "community", action: "create_moment" },
  { resource: "community", action: "comment" },
  { resource: "community", action: "report" },
  { resource: "training", action: "create" },
  { resource: "training", action: "read" },
  { resource: "training", action: "write_own" },
  { resource: "training", action: "delete_own" },
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
  { resource: "legal", action: "manage" },
];

// ── 工具 ──────────────────────────────────────────────────
/**
 * 生成一个新的 UUID 字符串。
 *
 * 用于权限记录等需要唯一主键的插入场景。
 *
 * @returns 随机生成的 UUID 字符串
 */
function uuid(): string {
  return crypto.randomUUID() as string;
}

/**
 * 生成当前时刻的 ISO 8601 时间戳字符串。
 *
 * 用于种子数据的 created_at / updated_at 字段。
 *
 * @returns 当前时间的 ISO 8601 字符串
 */
function now(): string {
  return new Date().toISOString();
}

// ── 系统角色名常量 ────────────────────────────────────────
const ROLE_ADMIN = "admin";
const ROLE_USER = "user";

/** 权限映射键：resource:action。 */
function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/**
 * 读取全部权限的 resource:action 到 id 的映射。
 *
 * 一次查询供默认授权与撤销复用；权限总量固定在几十条量级。
 *
 * @returns 权限映射表
 */
async function loadPermissionIdMap(): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({
      id: permissions.id,
      resource: permissions.resource,
      action: permissions.action,
    })
    .from(permissions);
  return new Map(
    rows.map((row) => [permissionKey(row.resource, row.action), row.id]),
  );
}

/**
 * 按现有角色 name 查真实 ID。
 *
 * 缺失时返回 undefined：独立执行 bootstrap:admin 等场景下 roles 可能尚未 seed，
 * 调用方按非致命处理，保持既有语义。
 *
 * @param name 角色名
 * @returns 真实角色 ID 或 undefined
 */
async function findRoleIdByName(name: string): Promise<string | undefined> {
  const [role] = await getDb()
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1);
  return role?.id;
}

/**
 * 为指定角色批量补齐默认权限。
 *
 * 先读现有角色与权限（各一次查询），再构造关联数组一次插入；已存在的关联由
 * ON CONFLICT DO NOTHING 跳过，空数组不发语句。
 *
 * @param roleName 角色名
 * @param defaults 该角色的默认权限集合
 * @returns 无返回值
 */
async function assignRolePermissions(
  roleName: string,
  defaults: Array<{ resource: string; action: string }>,
): Promise<void> {
  const roleId = await findRoleIdByName(roleName);
  if (!roleId) return;

  const permissionIds = await loadPermissionIdMap();
  const seen = new Set<string>();
  const rows: Array<{ role_id: string; permission_id: string }> = [];
  for (const { resource, action } of defaults) {
    const permissionId = permissionIds.get(permissionKey(resource, action));
    if (!permissionId || seen.has(permissionId)) continue;
    seen.add(permissionId);
    rows.push({ role_id: roleId, permission_id: permissionId });
  }
  if (rows.length === 0) return;

  await getDb().insert(rolePermissions).values(rows).onConflictDoNothing();
}

// ── 公开 API ─────────────────────────────────────────────

/**
 * 幂等创建系统预置角色（admin、user）。
 *
 * 两个角色一次 values([...]) 写入，按 name 冲突忽略插入；运维用自定义 UUID 建过的
 * 同名角色会被保留并继续复用。重复调用安全。
 *
 * @returns 无返回值
 */
export async function ensureSystemRoles(): Promise<void> {
  const db = getDb();
  const timestamp = now();

  await db.insert(roles).values([
    {
      id: ROLE_ADMIN,
      name: ROLE_ADMIN,
      description: "系统管理员",
      is_system: true,
      is_default: false,
      parent_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
    {
      id: ROLE_USER,
      name: ROLE_USER,
      description: "普通用户",
      is_system: true,
      is_default: true,
      parent_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  ]).onConflictDoNothing({ target: roles.name });
}

/**
 * 幂等创建系统权限定义（来自 PERMISSION_DEFS）。
 *
 * 全量权限一次批量 upsert：为每个权限项生成 UUID 主键，按 (resource, action)
 * 冲突时仅同步 description。权限描述以代码为唯一真相源（管理端不可编辑），
 * 存量库在启动时自动更新为最新文案，无需为改描述单独写数据迁移；
 * 主键与角色绑定保持不变。描述未变化时 setWhere 跳过写入，
 * 避免每次启动产生无意义的行更新。
 *
 * @returns 无返回值
 */
export async function ensurePermissions(): Promise<void> {
  const db = getDb();

  const rows = PERMISSION_DEFS.map((perm) => ({
    id: uuid(),
    resource: perm.resource,
    action: perm.action,
    description: perm.description,
  }));
  if (rows.length === 0) return;

  await db.insert(permissions).values(rows).onConflictDoUpdate({
    target: [permissions.resource, permissions.action],
    set: { description: sql`excluded.description` },
    // 描述未变化时跳过写入，避免每次启动产生无意义的行更新
    setWhere:
      sql`${permissions.description} IS DISTINCT FROM excluded.description`,
  });
}

/**
 * 幂等为 user 角色分配 USER_DEFAULT_PERMISSIONS 中定义的默认权限。
 *
 * 按 resource:action 匹配现有权限并一次批量写入 role_permissions，
 * 已存在则忽略；角色或权限缺失时不发语句。
 *
 * @returns 无返回值
 */
export async function ensureUserRolePermissions(): Promise<void> {
  await assignRolePermissions(ROLE_USER, USER_DEFAULT_PERMISSIONS);
}

/**
 * 幂等为 admin 角色分配 ADMIN_DEFAULT_PERMISSIONS 中定义的默认权限。
 *
 * 按 resource:action 匹配现有权限并一次批量写入 role_permissions，
 * 已存在则忽略；角色或权限缺失时不发语句。
 *
 * @returns 无返回值
 */
export async function ensureAdminRolePermissions(): Promise<void> {
  await assignRolePermissions(ROLE_ADMIN, ADMIN_DEFAULT_PERMISSIONS);
}

/**
 * 为尚无任何 user_roles 关联的存量用户补齐默认 user 角色。
 * （users.role 列已废弃删除；历史迁移过的数据不受影响）
 *
 * 单条 INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT DO NOTHING：
 * 只补完全没有角色的用户，已有其他角色的用户不会被追加 user 角色；
 * root（UID=0）显式排除。没有待补用户时语句本身即为 no-op。
 *
 * @returns 无返回值
 */
export async function migrateExistingUsers(): Promise<void> {
  const userRoleId = await findRoleIdByName(ROLE_USER);
  if (!userRoleId) return;

  await getDb().execute(sql`
    INSERT INTO ${userRoles} (user_id, role_id)
    SELECT u.id, ${userRoleId}
    FROM ${users} AS u
    WHERE u.id <> ${ROOT_USER_ID}
      AND NOT EXISTS (
        SELECT 1 FROM ${userRoles} AS ur WHERE ur.user_id = u.id
      )
    ON CONFLICT DO NOTHING
  `);
}

/**
 * NOJ-062：敏感字段权限从 user 角色撤销一次。
 *
 * 升级/初始化时执行一次集合 delete，之后写入 system_settings 内部标记；
 * 管理员后续在 RBAC 面板中给 user 角色重新授权后，重启不会被本函数再次撤销。
 *
 * 直接读写 system_settings 表（不走 settings 服务层缓存）：本函数在启动期
 * ensureRbacSeeds 中调用，此时 settings 缓存尚未初始化（main.ts 顺序）。
 *
 * @returns 无返回值
 */
export async function ensureSensitiveFieldDefaultPermissions(): Promise<void> {
  const db = getDb();

  const userRoleId = await findRoleIdByName(ROLE_USER);
  if (!userRoleId) return;

  const [marker] = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, SENSITIVE_FIELD_REVOKE_SEED_KEY))
    .limit(1);
  if (marker) return;

  const permissionIds = await loadPermissionIdMap();
  const sensitiveIds = SENSITIVE_FIELD_REVOKE_PERMISSIONS
    .map(({ resource, action }) =>
      permissionIds.get(permissionKey(resource, action))
    )
    .filter((id): id is string => Boolean(id));

  if (sensitiveIds.length > 0) {
    await db.delete(rolePermissions).where(
      and(
        eq(rolePermissions.role_id, userRoleId),
        inArray(rolePermissions.permission_id, sensitiveIds),
      ),
    );
  }

  await db.insert(systemSettings).values({
    key: SENSITIVE_FIELD_REVOKE_SEED_KEY,
    value: "1",
    description: "内部：NOJ-062 敏感字段默认权限已撤销（勿手动修改）",
    is_secret: false,
    updated_at: now(),
    updated_by: ROOT_USER_ID,
  }).onConflictDoNothing();
}

/**
 * 全量幂等初始化。应在启动期（migration 后）或 seed 时调用。
 *
 * @returns 无返回值
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
