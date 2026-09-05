import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { users } from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  RateLimitedError,
} from "../../../shared/base/errors.ts";
import { logger } from "../../../shared/base/logging.ts";
import { generateResetToken, hashResetToken } from "./security/resetToken.ts";
import {
  logAuthEvent,
  sendEmailVerificationEmail,
} from "../../system/index.ts";

export const EMAIL_VERIFICATION_TTL_MINUTES = 30;

/** 邮箱验证邮件的发送结果；原始令牌仅供调用方完成隔离的 E2E 流程。 */
export interface EmailVerificationDispatch {
  sent: boolean;
  token: string | null;
}

function resolveAppUrl(requestFallbackBaseUrl: string): string | null {
  const configured = Deno.env.get("APP_URL")?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (Deno.env.get("NOJ_ENV") === "production") {
    logger.error("生产环境未配置 APP_URL，无法发送邮箱验证邮件", {
      module: "email-verification",
    });
    return null;
  }
  return requestFallbackBaseUrl.replace(/\/+$/, "");
}

/** 为尚未验证的活跃用户生成一次性验证令牌并发送邮件。 */
export async function sendEmailVerification(
  userId: string,
  requestFallbackBaseUrl: string,
  enforceCooldown = false,
): Promise<EmailVerificationDispatch> {
  const baseUrl = resolveAppUrl(requestFallbackBaseUrl);
  if (!baseUrl) return { sent: false, token: null };
  const db = getDb();
  const [user] = await db.select({
    email: users.email,
    verified: users.email_verified,
    expiresAt: users.email_verify_expires_at,
  }).from(users).where(and(eq(users.id, userId), isNull(users.deleted_at)))
    .limit(1);
  if (!user || user.verified) return { sent: false, token: null };
  if (
    enforceCooldown && user.expiresAt &&
    Date.parse(user.expiresAt) >
      Date.now() + (EMAIL_VERIFICATION_TTL_MINUTES - 1) * 60_000
  ) {
    throw new RateLimitedError("验证邮件发送过于频繁，请稍后再试", 60);
  }

  const token = generateResetToken();
  const tokenHash = await hashResetToken(token);
  const expiresAt = new Date(
    Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60_000,
  ).toISOString();
  await db.update(users).set({
    email_verify_token: tokenHash,
    email_verify_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).where(eq(users.id, userId));

  try {
    const sent = await sendEmailVerificationEmail(
      user.email,
      `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`,
      EMAIL_VERIFICATION_TTL_MINUTES,
    );
    if (!sent) {
      await db.update(users).set({
        email_verify_token: null,
        email_verify_expires_at: null,
      }).where(
        and(eq(users.id, userId), eq(users.email_verify_token, tokenHash)),
      );
    }
    return { sent, token: sent ? token : null };
  } catch (error) {
    await db.update(users).set({
      email_verify_token: null,
      email_verify_expires_at: null,
    }).where(
      and(eq(users.id, userId), eq(users.email_verify_token, tokenHash)),
    );
    logger.error("邮箱验证邮件发送失败", {
      module: "email-verification",
      error,
    });
    return { sent: false, token: null };
  }
}

/** 消费验证令牌。令牌错误、过期或已使用时统一返回相同错误。 */
export async function verifyEmailToken(
  token: string,
  clientIp?: string,
): Promise<void> {
  if (!token) {
    throw new BadRequestError("验证链接无效或已过期", "EMAIL_VERIFY_INVALID");
  }
  const tokenHash = await hashResetToken(token);
  const now = new Date().toISOString();
  const [updated] = await getDb().update(users).set({
    email_verified: true,
    email_verify_token: null,
    email_verify_expires_at: null,
    updated_at: now,
  }).where(and(
    eq(users.email_verify_token, tokenHash),
    gt(users.email_verify_expires_at, now),
    eq(users.email_verified, false),
    isNull(users.deleted_at),
  )).returning({ id: users.id });
  if (!updated) {
    throw new BadRequestError("验证链接无效或已过期", "EMAIL_VERIFY_INVALID");
  }
  await logAuthEvent(updated.id, clientIp ?? "unknown", "auth.email_verified", {
    user_id: updated.id,
  });
}
