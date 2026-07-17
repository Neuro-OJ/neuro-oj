import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { passwordResetTokens, users } from "../db/schema.ts";
import { hashPassword } from "../lib/password.ts";
import { generateResetToken, hashResetToken } from "../lib/resetToken.ts";
import { sendPasswordResetEmail } from "../lib/email.ts";
import { BadRequestError } from "../lib/errors.ts";
import { logAuthEvent } from "./audit-log.ts";
import { validatePasswordStrength } from "./auth.ts";

/** 密码重置令牌有效期（分钟）。OWASP 2025+ 建议 ≤ 15 分钟。 */
const TOKEN_TTL_MINUTES = 15;

/**
 * 发起密码重置请求（issue #49 + PR-2 审计）。
 *
 * 防枚举行为：不管邮箱是否已注册，函数 MUST 不抛出业务错误且 MUST 同步返回。
 * 邮箱存在时才生成 token + 发送邮件，邮箱不存在时静默返回。
 *
 * 审计：写入 `auth.forgot_password_request`（PR-2），包含 email_exists
 * 标志用于追溯攻击者的撞邮箱行为。email 不写入 detail（防敏感信息泄露）。
 *
 * @param email - 用户输入的邮箱
 * @param appBaseUrl - 应用基础 URL（用于拼 reset link）
 * @param clientIp - 客户端 IP（用于审计 + 防滥用追溯）
 */
export async function requestReset(
  email: string,
  appBaseUrl: string,
  clientIp?: string,
): Promise<void> {
  const db = getDb();

  // 查用户（按 email）
  const userRows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (userRows.length === 0) {
    // 防枚举：邮箱不存在时静默返回（但不漏审计）
    await logAuthEvent(
      null,
      clientIp ?? "unknown",
      "auth.forgot_password_request",
      { action: "auth.forgot_password_request", email_exists: false },
    );
    return;
  }

  const userId = userRows[0].id;

  // 生成 token + hash
  const plainToken = generateResetToken();
  const tokenHash = await hashResetToken(plainToken);

  // 写入 DB
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MINUTES * 60_000);
  const nowIso = now.toISOString();
  const expiresIso = expiresAt.toISOString();

  await db.insert(passwordResetTokens).values({
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresIso,
    used_at: null,
    created_at: nowIso,
  });

  // 发送邮件
  const resetLink = `${appBaseUrl}/reset-password?token=${plainToken}`;
  await sendPasswordResetEmail(email, resetLink, TOKEN_TTL_MINUTES);

  // 审计：邮箱存在 → 记录成功（便于追溯撞邮箱行为）
  await logAuthEvent(
    userId,
    clientIp ?? "unknown",
    "auth.forgot_password_request",
    { action: "auth.forgot_password_request", email_exists: true },
  );
}

/**
 * 执行密码重置（issue #49）。
 *
 * 流程：
 * 1. 用 tokenHash 查表（不消耗），确认令牌有效 + 拿 user_id
 * 2. 查 user 拿 username/email
 * 3. 校验密码强度（弱密码不消耗 token，用户可重试）
 * 4. 事务内：原子消耗 token + 改密码
 *
 * @param token - 邮件 URL 中的明文 token
 * @param newPassword - 用户输入的新密码
 * @throws {BadRequestError} 令牌无效/过期/已用；密码强度不足
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  clientIp?: string,
): Promise<void> {
  const db = getDb();
  const tokenHash = await hashResetToken(token);
  const nowIso = new Date().toISOString();

  // 1. 查 token 行（不消耗，仅验证）
  const tokenRows = await db
    .select({ userId: passwordResetTokens.user_id })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.token_hash, tokenHash),
        isNull(passwordResetTokens.used_at),
        gt(passwordResetTokens.expires_at, nowIso),
      ),
    )
    .limit(1);

  if (tokenRows.length === 0) {
    throw new BadRequestError("重置令牌无效或已过期");
  }

  // 2. 查 user
  const userRows = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(eq(users.id, tokenRows[0].userId))
    .limit(1);

  if (userRows.length === 0) {
    // 用户已被删除（FK CASCADE 理论上不会出现此情况）
    throw new BadRequestError("重置令牌无效或已过期");
  }
  const user = userRows[0];

  // 3. 校验密码强度（弱密码不消耗 token）
  validatePasswordStrength(newPassword, user.username, user.email);

  // 4. 事务：消耗 token + 改密码
  const newHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    // 原子消耗 token：affected=0 表示并发场景下被抢先消耗
    const consumed = await tx
      .update(passwordResetTokens)
      .set({ used_at: nowIso })
      .where(
        and(
          eq(passwordResetTokens.token_hash, tokenHash),
          isNull(passwordResetTokens.used_at),
          gt(passwordResetTokens.expires_at, nowIso),
        ),
      )
      .returning({ id: passwordResetTokens.id });

    if (consumed.length === 0) {
      throw new BadRequestError("重置令牌无效或已过期");
    }

    // 更新密码
    await tx
      .update(users)
      .set({ password_hash: newHash, updated_at: nowIso })
      .where(eq(users.id, user.id));
  });

  // 审计：密码重置成功（事务提交后异步写；写失败不影响主业务）
  await logAuthEvent(
    user.id,
    clientIp ?? "unknown",
    "auth.password_reset",
    { action: "auth.password_reset", user_id: user.id },
  );
}
