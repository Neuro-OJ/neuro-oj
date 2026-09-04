import {
  and,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { userBans, userRoles, users } from "./../../../../shared/db/schema.ts";
import { getAdminUserIds, isUserAdmin } from "./../security/permissions.ts";
import { UnauthorizedError } from "./../../../../shared/base/errors.ts";
import type { UserResponse } from "./../../types/auth.ts";
import { toUserResponse } from "./auth-register.ts";

/**
 * 根据用户 ID 获取用户信息。
 *
 * @throws {UnauthorizedError} 用户不存在
 */
export async function getUserProfile(
  userId: string,
): Promise<UserResponse> {
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (existing.length === 0) {
    throw new UnauthorizedError("用户不存在");
  }

  // is_admin 实时计算（权限集含 admin:full_access，含继承链）
  const isAdmin = await isUserAdmin(userId);

  return toUserResponse(existing[0], { isAdmin });
}

/**
 * 管理员获取用户列表（分页，排除 root 系统用户）。
 * 返回用户基本信息，不含密码哈希。
 *
 * @param opts.keyword 搜索关键词（匹配 username 或 email，ILIKE 模糊搜索）
 * @param opts.isAdmin 按管理员状态筛选（true | false，admin:full_access 权限含继承链）
 * @param opts.from 注册日期范围起始（ISO 字符串）
 * @param opts.to 注册日期范围截止（ISO 字符串）
 */
export async function listUsers(
  opts: {
    page: number;
    perPage: number;
    keyword?: string;
    isAdmin?: boolean;
    from?: string;
    to?: string;
  },
): Promise<
  {
    data: UserResponse[];
    pagination: {
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    };
  }
> {
  const db = getDb();
  const offset = (opts.page - 1) * opts.perPage;

  // 构建筛选条件
  const conditions: SQL[] = [];

  // 排除 root 系统用户（id='0'）
  conditions.push(sql`${users.id} <> '0'`);

  // 按管理员状态筛选（admin:full_access 权限，含继承链）
  if (opts.isAdmin !== undefined) {
    const adminIds = await getAdminUserIds();
    if (opts.isAdmin) {
      conditions.push(inArray(users.id, [...adminIds]));
    } else {
      conditions.push(notInArray(users.id, [...adminIds]));
    }
  }

  // 按关键词搜索（username 或 email ILIKE 模糊匹配）
  if (opts.keyword) {
    const kw = `%${opts.keyword}%`;
    // or() 在传参非空时必返回 SQL 实例（类型层面为 optional）
    conditions.push(or(ilike(users.username, kw), ilike(users.email, kw))!);
  }

  // 按注册日期范围筛选
  if (opts.from) {
    conditions.push(gte(users.created_at, opts.from));
  }
  if (opts.to) {
    conditions.push(lte(users.created_at, opts.to));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        must_change_password: users.must_change_password,
        password_hash: users.password_hash,
        avatar_url: users.avatar_url,
        tfa_enabled: users.tfa_enabled,
        created_at: users.created_at,
        updated_at: users.updated_at,
        // 活跃封禁信息（LEFT JOIN user_bans）
        ban_reason: userBans.reason,
        ban_until: userBans.banned_until,
        ban_scope: userBans.scope,
      })
      .from(users)
      .leftJoin(
        userBans,
        and(eq(userBans.user_id, users.id), isNull(userBans.unbanned_at)),
      )
      .where(where)
      .orderBy(users.created_at)
      .limit(opts.perPage)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(where),
  ]);

  const roleRows = rows.length === 0 ? [] : await db
    .select({ user_id: userRoles.user_id, role_id: userRoles.role_id })
    .from(userRoles)
    .where(inArray(userRoles.user_id, rows.map((row) => row.id)));
  const roleIdsByUser = new Map<string, string[]>();
  for (const roleRow of roleRows) {
    const roleIds = roleIdsByUser.get(roleRow.user_id) ?? [];
    roleIds.push(roleRow.role_id);
    roleIdsByUser.set(roleRow.user_id, roleIds);
  }

  // 本页用户的管理员状态（admin:full_access 权限，含继承链）
  const allAdminIds = await getAdminUserIds();

  const total = Number(countResult[0]?.count ?? 0);
  const totalPages = Math.ceil(total / opts.perPage);

  // 将 LEFT JOIN 结果映射为 UserResponse
  const data = rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role_ids: roleIdsByUser.get(row.id) ?? [],
    is_admin: allAdminIds.has(row.id),
    has_local_password: row.password_hash !== null,
    must_change_password: row.must_change_password,
    avatar_url: row.avatar_url ?? null,
    tfa_enabled: row.tfa_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    active_ban: row.ban_reason !== null
      ? {
        reason: row.ban_reason!,
        banned_until: row.ban_until,
        scope: (row.ban_scope === "social" ? "social" : "platform") as
          | "platform"
          | "social",
      }
      : null,
  }));

  return {
    data,
    pagination: {
      page: opts.page,
      per_page: opts.perPage,
      total,
      total_pages: totalPages,
    },
  };
}
