/**
 * 修改当前用户密码（issue #75）。
 *
 * 流程：
 * 1. 查询用户
 * 2. **先**验证旧密码（bcrypt 耗时恒定，挡住密码相等性 oracle）
 * 3. 新密码强度校验
 * 4. 拒绝新密码与旧密码相同（评审修复 M2：必须在 comparePassword 之后，
 *    避免攻击者通过响应时间差异推断旧密码长度/字符）
 * 5. 哈希新密码并 UPDATE，同时置 must_change_password=false
 * 6. 返回最新的 UserResponse 与本次更新产生的会话版本
 *
 * 密码与会话版本在同一条 UPDATE 中变更，全部旧会话立即失效；
 * 路由使用 UPDATE 返回的版本签发新 token，避免并发重置期间重新授权旧凭据。
 *
 * @throws {UnauthorizedError} 用户不存在或旧密码错误
 * @throws {BadRequestError} 新密码强度不足或与旧密码相同
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { users } from "./../../../../shared/db/schema.ts";
import { comparePassword, hashPassword } from "./../security/password.ts";
import { isUserAdmin } from "./../security/permissions.ts";
import { logAuthEvent } from "../../../system/index.ts";
import {
  BadRequestError,
  UnauthorizedError,
} from "./../../../../shared/base/errors.ts";
import type { UserResponse } from "./../../types/auth.ts";
import { validatePasswordStrength } from "./auth-register.ts";

/**
 * 修改当前用户密码。
 *
 * 流程：验证旧密码 → 新密码强度校验 → 拒绝新旧相同 → 哈希更新并清除
 * must_change_password 标记 → 记录审计日志 → 返回最新 UserResponse。
 *
 * @param userId 目标用户 ID
 * @param oldPassword 旧密码（用于验证）
 * @param newPassword 新密码（需通过强度校验且与旧密码不同）
 * @param clientIp 客户端 IP，用于审计日志（可选）
 * @returns 修改后的用户信息与会话版本（仅用于服务端签发新令牌）
 * @throws {UnauthorizedError} 用户不存在或旧密码错误
 * @throws {BadRequestError} 新密码强度不足、与旧密码相同或账号未设置本地密码
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
  clientIp?: string,
): Promise<{ user: UserResponse; sessionVersion: number }> {
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (existing.length === 0) {
    throw new UnauthorizedError("用户不存在");
  }

  const user = existing[0];

  if (!user.password_hash) {
    throw new BadRequestError(
      "当前账号尚未设置本地密码，请使用密码设定流程",
      "PASSWORD_SETUP_REQUIRED",
    );
  }

  // 1. 先验证旧密码（bcrypt 始终耗时 ~250ms，挡住 oracle）
  //    评审修复 M2：必须先于"新=旧"检查，使两条路径响应时间一致
  const oldValid = await comparePassword(oldPassword, user.password_hash);
  if (!oldValid) {
    throw new UnauthorizedError("旧密码错误");
  }

  // 2. 新密码强度校验（与注册保持一致）
  validatePasswordStrength(newPassword, user.username, user.email);

  // 3. 拒绝新密码与旧密码相同（issue #75 评审 H5）
  //    必须在 comparePassword 之后，避免攻击者通过响应时间差推断新=旧
  if (oldPassword === newPassword) {
    throw new BadRequestError("新密码不能与旧密码相同");
  }

  // 4. 哈希并 UPDATE
  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();

  const [updated] = await db
    .update(users)
    .set({
      password_hash: newHash,
      session_version: sql`${users.session_version} + 1`,
      must_change_password: false,
      updated_at: now,
    })
    .where(and(
      eq(users.id, userId),
      eq(users.session_version, user.session_version),
      eq(users.password_hash, user.password_hash),
    ))
    .returning({ sessionVersion: users.session_version });
  if (!updated) {
    throw new UnauthorizedError("密码已变更，请重新登录");
  }

  // PR-2 审计：改密成功（事务提交后异步写；写失败不影响主业务）
  await logAuthEvent(
    userId,
    clientIp ?? "unknown",
    "auth.change_password",
    { user_id: userId },
  );

  // 查询用户的 admin 状态（权限集含 admin:full_access，含继承）
  const isAdmin = await isUserAdmin(user.id);

  return {
    sessionVersion: updated.sessionVersion,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      is_admin: isAdmin,
      has_local_password: true,
      must_change_password: false,
      email_verified: user.email_verified,
      active_ban: null,
      avatar_url: user.avatar_url ?? null,
      tfa_enabled: user.tfa_enabled,
      created_at: user.created_at,
      updated_at: now,
    },
  };
}
