/**
 * 管理员封禁用户（issue #102 / user-ban-table）。
 *
 * 使用 user_bans 表追踪封禁记录（方案 A：以最新为准）：
 * 1. 关闭已有活跃封禁（SET unbanned_at=now）
 * 2. INSERT 新封禁记录
 *
 * 业务规则：
 * - 禁止封禁 root（id='0'）
 * - 禁止封禁自己
 * - 禁止封禁最后一个可登录 admin
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import { userBans, users } from "../../db/schema.ts";
import { invalidateBanCache } from "../../lib/banCache.ts";
import { logAudit } from "../audit-log.ts";
import type { UserResponse } from "../../types/auth.ts";
import { ROOT_USER_ID } from "../../lib/constants.ts";
import { getAdminUserIds, isUserAdmin } from "../../lib/permissions.ts";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.ts";

/** users 表行类型 */
type UserRow = typeof users.$inferSelect;

/** 按 ID 查询用户，不存在则抛 NotFoundError。 */
async function requireUser(targetUserId: string): Promise<UserRow> {
  const existing = await getDb().select().from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("用户不存在");
  }
  return existing[0];
}

/** 由 users 行构造 UserResponse（active_ban 由调用方提供，is_admin 实时计算）。 */
async function toUserResponse(
  user: UserRow,
  activeBan: UserResponse["active_ban"],
  now: string,
): Promise<UserResponse> {
  const isAdmin = await isUserAdmin(user.id);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    is_admin: isAdmin,
    must_change_password: user.must_change_password,
    active_ban: activeBan,
    avatar_url: user.avatar_url ?? null,
    created_at: user.created_at,
    updated_at: now,
  };
}

export async function banUser(
  targetUserId: string,
  reason: string | undefined,
  bannedUntil: string | null | undefined,
  currentUserId: string,
): Promise<UserResponse> {
  if (targetUserId === ROOT_USER_ID) {
    throw new BadRequestError("不能封禁 root 账户");
  }
  if (currentUserId === targetUserId) {
    throw new BadRequestError("不能封禁自己");
  }

  if (bannedUntil) {
    const t = Date.parse(bannedUntil);
    if (Number.isNaN(t)) {
      throw new ValidationError("banned_until 必须是有效 ISO 8601 字符串");
    }
  }

  const db = getDb();
  const existing = await requireUser(targetUserId);

  // 防封禁最后一个 admin（admin:full_access 权限，含继承链，排除 root）
  if (await isUserAdmin(existing.id)) {
    const adminIds = await getAdminUserIds();
    const adminCount = [...adminIds].filter((id) => id !== ROOT_USER_ID).length;
    if (adminCount <= 1) {
      throw new BadRequestError(
        "系统当前仅有 1 个可登录管理员，不能封禁；如需调整请先创建新的管理员账户",
      );
    }
  }

  const now = new Date().toISOString();

  // 1. 关闭已有活跃封禁
  await db.update(userBans)
    .set({ unbanned_at: now })
    .where(
      and(eq(userBans.user_id, targetUserId), isNull(userBans.unbanned_at)),
    );

  // 2. 插入新封禁记录
  const banId = crypto.randomUUID();
  await db.insert(userBans).values({
    id: banId,
    user_id: targetUserId,
    reason: reason ?? "",
    banned_until: bannedUntil ?? null,
    banned_at: now,
    banned_by: currentUserId,
  });

  invalidateBanCache({ userId: targetUserId });
  await logAudit(
    "users.ban",
    { action: "users.ban", reason: reason ?? "", until: bannedUntil ?? null },
    { type: "users", id: targetUserId },
  );

  return await toUserResponse(
    existing,
    { reason: reason ?? "", banned_until: bannedUntil ?? null },
    now,
  );
}

/**
 * 管理员解封用户（issue #102 / user-ban-table）。
 *
 * 将活跃封禁记录的 unbanned_at/unbanned_by 设为当前值。
 */
export async function unbanUser(
  targetUserId: string,
  currentUserId: string,
): Promise<UserResponse> {
  const db = getDb();
  const existing = await requireUser(targetUserId);

  const now = new Date().toISOString();
  await db.update(userBans)
    .set({ unbanned_at: now, unbanned_by: currentUserId })
    .where(
      and(eq(userBans.user_id, targetUserId), isNull(userBans.unbanned_at)),
    );

  invalidateBanCache({ userId: targetUserId });
  await logAudit(
    "users.unban",
    { action: "users.unban" },
    { type: "users", id: targetUserId },
  );

  return await toUserResponse(existing, null, now);
}

/**
 * 获取用户封禁历史（user-ban-table）。
 * 返回所有封禁记录，按 banned_at DESC 排序。
 * JOIN users 以获取 banned_by / unbanned_by 的用户名。
 */
export interface BanRecord {
  id: string;
  reason: string;
  banned_until: string | null;
  banned_at: string;
  banned_by: { id: string; username: string } | null;
  unbanned_at: string | null;
  unbanned_by: { id: string; username: string } | null;
}

export async function getUserBanHistory(
  userId: string,
): Promise<BanRecord[]> {
  const db = getDb();
  const unbannedUser = db.select().from(users).as("unbanned_user");

  const rows = await db
    .select({
      id: userBans.id,
      reason: userBans.reason,
      banned_until: userBans.banned_until,
      banned_at: userBans.banned_at,
      banned_by_id: userBans.banned_by,
      banned_by_username: users.username,
      unbanned_at: userBans.unbanned_at,
      unbanned_by_id: userBans.unbanned_by,
      unbanned_by_username: unbannedUser.username,
    })
    .from(userBans)
    .leftJoin(users, eq(userBans.banned_by, users.id))
    .leftJoin(unbannedUser, eq(userBans.unbanned_by, unbannedUser.id))
    .where(eq(userBans.user_id, userId))
    .orderBy(sql`${userBans.banned_at} DESC`);

  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    banned_until: r.banned_until,
    banned_at: r.banned_at,
    banned_by: r.banned_by_id
      ? { id: r.banned_by_id, username: r.banned_by_username ?? "" }
      : null,
    unbanned_at: r.unbanned_at,
    unbanned_by: r.unbanned_by_id
      ? { id: r.unbanned_by_id, username: r.unbanned_by_username ?? "" }
      : null,
  }));
}
