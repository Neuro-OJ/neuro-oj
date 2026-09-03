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
 * 6. 返回最新的 UserResponse
 *
 * 注意：旧 JWT 仍有效至自然过期——前端应在成功后清 Cookie 重登
 * （/api/v1/auth/change-password 路由层会清 cookie + 重新登录获取新 token）。
 *
 * @throws {UnauthorizedError} 用户不存在或旧密码错误
 * @throws {BadRequestError} 新密码强度不足或与旧密码相同
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import { users } from "../../../../db/schema.ts";
import { comparePassword, hashPassword } from "../../../../lib/password.ts";
import { isUserAdmin } from "../../../../lib/permissions.ts";
import { logAuthEvent } from "../../../system/index.ts";
import {
  BadRequestError,
  UnauthorizedError,
} from "./../../../../shared/base/errors.ts";
import type { UserResponse } from "../../../../types/auth.ts";
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
 * @returns 修改后的用户信息
 * @throws {UnauthorizedError} 用户不存在或旧密码错误
 * @throws {BadRequestError} 新密码强度不足、与旧密码相同或账号未设置本地密码
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
  clientIp?: string,
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

  await db
    .update(users)
    .set({
      password_hash: newHash,
      must_change_password: false,
      updated_at: now,
    })
    .where(eq(users.id, userId));

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
    id: user.id,
    username: user.username,
    email: user.email,
    is_admin: isAdmin,
    has_local_password: true,
    must_change_password: false,
    active_ban: null,
    avatar_url: user.avatar_url ?? null,
    tfa_enabled: user.tfa_enabled,
    created_at: user.created_at,
    updated_at: now,
  };
}
