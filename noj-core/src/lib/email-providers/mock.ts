/**
 * 邮件发送 Mock Provider。
 *
 * 默认行为：仅通过 logger 打印邮件内容。
 * 用于本地开发与 E2E 测试。
 */

import type { SendPasswordResetEmail } from "./types.ts";
import { logger } from "../logging.ts";

/**
 * 发送密码重置邮件（mock 模式）。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于日志展示
 */
function redactResetToken(resetLink: string): string {
  return resetLink.replace(
    /([?&](?:token|reset_token)=)[^&#]*/gi,
    "$1[REDACTED]",
  );
}

export const sendPasswordResetEmail: SendPasswordResetEmail = (
  email: string,
  resetLink: string,
  expiresInMinutes = 15,
) => {
  // NOJ-005：mock 仅用于开发/测试。生产环境必须使用真实 Provider，
  // 禁止把含明文重置令牌的链接写入日志。
  const nojEnv = Deno.env.get("NOJ_ENV");
  if (nojEnv === "production") {
    throw new Error(
      "EMAIL_PROVIDER=mock 在生产环境不可用，请配置 aliyun/tencent 邮件 Provider",
    );
  }
  // 本地开发/测试需要从日志拿到完整链接才能完成重置；未知的非生产环境保守脱敏。
  const isDevOrTest = nojEnv === "development" || nojEnv === "test" || !nojEnv;
  const link = isDevOrTest ? resetLink : redactResetToken(resetLink);
  logger.info("密码重置邮件（mock）", {
    module: "email-mock",
    event: "password_reset",
    to: email,
    link,
    expiresIn: `${expiresInMinutes} minutes`,
  });
  return Promise.resolve();
};
