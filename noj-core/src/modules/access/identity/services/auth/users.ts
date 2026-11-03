import {
  and,
  eq,
  gte,
  ilike,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { userBans, users } from "../../../../../shared/db/schema.ts";
import { UnauthorizedError } from "../../../../../shared/base/errors.ts";
import type { UserResponse } from "../../types/auth.ts";
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
    .where(and(eq(users.id, userId), isNull(users.deleted_at)))
    .limit(1);

  if (existing.length === 0) {
    throw new UnauthorizedError("用户不存在");
  }

  return toUserResponse(existing[0]);
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

  // 按平台角色筛选（单值 users.role）
  if (opts.isAdmin !== undefined) {
    conditions.push(eq(users.role, opts.isAdmin ? "admin" : "user"));
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
        role: users.role,
        must_change_password: users.must_change_password,
        email_verified: users.email_verified,
        password_hash: users.password_hash,
        avatar_url: users.avatar_url,
        tfa_enabled: users.tfa_enabled,
        created_at: users.created_at,
        updated_at: users.updated_at,
        deleted_at: users.deleted_at,
        // 活跃封禁信息（LEFT JOIN user_bans）
        ban_reason: userBans.reason,
        ban_until: userBans.banned_until,
        ban_scope: userBans.scope,
        ban_updated_at: userBans.updated_at,
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
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(where),
  ]);

  const total = Number(countResult[0]?.count ?? 0);
  const totalPages = Math.ceil(total / opts.perPage);

  // 将 LEFT JOIN 结果映射为 UserResponse
  const data = rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.deleted_at ? "user" : row.role,
    is_admin: !row.deleted_at && row.role === "admin",
    has_local_password: row.password_hash !== null,
    must_change_password: row.must_change_password,
    email_verified: row.email_verified,
    avatar_url: row.avatar_url ?? null,
    tfa_enabled: row.tfa_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    active_ban: row.ban_reason !== null
      ? {
        reason: row.ban_reason!,
        banned_until: row.ban_until,
        scope: (row.ban_scope === "social" ? "social" : "platform") as
          | "platform"
          | "social",
        updated_at: row.ban_updated_at,
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
