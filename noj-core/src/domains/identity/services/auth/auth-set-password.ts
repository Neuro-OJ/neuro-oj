/** 为尚未设置本地密码的 OAuth 用户补设密码。 */

import { eq } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { users } from "./../../../../shared/db/schema.ts";
import { hashPassword } from "./../security/password.ts";
import { isUserAdmin } from "./../security/permissions.ts";
import { logAuthEvent } from "../../../system/index.ts";
import {
  BadRequestError,
  UnauthorizedError,
} from "./../../../../shared/base/errors.ts";
import type { UserResponse } from "../../../../types/auth.ts";
import { toUserResponse, validatePasswordStrength } from "./auth-register.ts";

/**
 * 为尚未设置本地密码的 OAuth 用户补设密码。
 *
 * 校验用户存在且未设置本地密码，通过强度校验后哈希更新，并记录审计日志。
 *
 * @param userId 目标用户 ID
 * @param newPassword 新密码（需通过强度校验）
 * @param clientIp 客户端 IP，用于审计日志（可选）
 * @returns 补设密码后的用户信息
 * @throws {UnauthorizedError} 用户不存在
 * @throws {BadRequestError} 账号已有本地密码或新密码强度不足
 */
export async function setPassword(
  userId: string,
  newPassword: string,
  clientIp?: string,
): Promise<UserResponse> {
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.id, userId))
    .limit(1);
  const user = existing[0];
  if (!user) throw new UnauthorizedError("用户不存在");
  if (user.password_hash) {
    throw new BadRequestError(
      "当前账号已有本地密码，请使用修改密码流程",
      "PASSWORD_ALREADY_SET",
    );
  }

  validatePasswordStrength(newPassword, user.username, user.email);
  const now = new Date().toISOString();
  await db.update(users).set({
    password_hash: await hashPassword(newPassword),
    updated_at: now,
  }).where(eq(users.id, userId));

  await logAuthEvent(userId, clientIp ?? "unknown", "auth.change_password", {
    user_id: userId,
  });
  const updated = { ...user, password_hash: "set", updated_at: now };
  return toUserResponse(updated, { isAdmin: await isUserAdmin(userId) });
}
