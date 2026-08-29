/** 为尚未设置本地密码的 OAuth 用户补设密码。 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import { users } from "../../db/schema.ts";
import { hashPassword } from "../../lib/password.ts";
import { isUserAdmin } from "../../lib/permissions.ts";
import { logAuthEvent } from "../audit-log.ts";
import { BadRequestError, UnauthorizedError } from "../../lib/errors.ts";
import type { UserResponse } from "../../types/auth.ts";
import { toUserResponse, validatePasswordStrength } from "./auth-register.ts";

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
