import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { publishSearchIndexEvent } from "../../../shared/search-events.ts";
import {
  oauthAccounts,
  passwordResetTokens,
  tfaRecoveryCodes,
  userBans,
  userRoles,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import { ROOT_USER_ID } from "../../../shared/base/constants.ts";
import { comparePassword } from "./security/password.ts";
import { logAudit, logAuthEvent } from "../../system/index.ts";
import { deleteAvatarIfUnreferenced } from "./users/users-avatar.ts";
import { getAdminUserIds, isUserAdmin } from "./security/permissions.ts";
import {
  assertAccountHasNoOwnedDomain,
  retireAccountWorkspaceMemberships,
} from "../../workspace/index.ts";

async function anonymizeUser(
  userId: string,
  actorId?: string,
  expectedPasswordHash?: string,
): Promise<string> {
  if (userId === ROOT_USER_ID) {
    throw new ForbiddenError("系统 root 账户不可注销");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const existing = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.id, userId))
      .for("update");
    if (!existing || existing.deleted_at) throw new NotFoundError("用户不存在");
    if (
      expectedPasswordHash && existing.password_hash !== expectedPasswordHash
    ) {
      throw new UnauthorizedError("密码已变化，请重新确认", "PASSWORD_INVALID");
    }
    await assertAccountHasNoOwnedDomain(tx, userId);
    await retireAccountWorkspaceMemberships(tx, userId, actorId ?? userId);
    await tx.update(users).set({
      username: "已注销用户",
      email: `deleted-${userId}@deleted.invalid`,
      password_hash: null,
      bio: "",
      avatar_url: null,
      must_change_password: false,
      email_verified: true,
      email_verify_token: null,
      email_verify_expires_at: null,
      tfa_secret_encrypted: null,
      tfa_enabled: false,
      deleted_at: now,
      updated_at: now,
    }).where(eq(users.id, userId));
    await tx.delete(oauthAccounts).where(eq(oauthAccounts.user_id, userId));
    await tx.delete(passwordResetTokens).where(
      eq(passwordResetTokens.user_id, userId),
    );
    await tx.delete(tfaRecoveryCodes).where(
      eq(tfaRecoveryCodes.user_id, userId),
    );
    await tx.delete(userRoles).where(eq(userRoles.user_id, userId));
    await tx.update(userBans).set({
      unbanned_at: now,
      unbanned_by: actorId ?? userId,
      updated_at: now,
    }).where(and(eq(userBans.user_id, userId), isNull(userBans.unbanned_at)));
    return existing;
  });
  if (existing.avatar_url) {
    try {
      await deleteAvatarIfUnreferenced(db, userId, existing.avatar_url);
    } catch { /* 沿用头像清理幂等行为；账号注销已提交。 */ }
  }
  return existing.username;
}

/** 用户通过本地密码确认后注销自己的账户。 */
export async function deleteOwnAccount(
  userId: string,
  password: string,
  clientIp?: string,
): Promise<void> {
  if (!password) throw new BadRequestError("请输入当前密码");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId))
    .limit(1);
  if (!user?.password_hash) {
    throw new BadRequestError("请先设置本地密码再注销账户");
  }
  if (!await comparePassword(password, user.password_hash)) {
    throw new UnauthorizedError("密码不正确", "PASSWORD_INVALID");
  }
  await anonymizeUser(userId, undefined, user.password_hash);
  await publishSearchIndexEvent("user", userId, "delete");
  await logAuthEvent(userId, clientIp ?? "unknown", "auth.delete_account", {
    user_id: userId,
  });
}

/** 管理员注销指定用户，并保留公共内容和审计链。 */
export async function adminDeleteAccount(
  userId: string,
  actorId?: string,
): Promise<void> {
  if (actorId === userId) {
    throw new BadRequestError(
      "管理员不能从后台注销自己，请使用个人设置中的注销入口",
    );
  }
  if (await isUserAdmin(userId)) {
    const adminIds = await getAdminUserIds();
    const activeAdminCount = [...adminIds].filter((id) => id !== ROOT_USER_ID)
      .length;
    if (activeAdminCount <= 1) {
      throw new BadRequestError("不能注销最后一个可登录管理员");
    }
  }
  const username = await anonymizeUser(userId, actorId);
  await publishSearchIndexEvent("user", userId, "delete");
  await logAudit("users.delete", { action: "users.delete", username }, {
    type: "user",
    id: userId,
  });
}
