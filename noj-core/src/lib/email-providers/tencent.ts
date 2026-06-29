/**
 * 腾讯云 SES 邮件发送 Provider。
 *
 * 使用 tencentcloud-sdk-nodejs-ses SDK 发送密码重置邮件。
 * 环境变量要求（EMAIL_PROVIDER=tencent 时必填）：
 *   TENCENT_SECRET_ID
 *   TENCENT_SECRET_KEY
 *   TENCENT_FROM_EMAIL
 *   TENCENT_REGION（默认 ap-guangzhou）
 */

import type { SendPasswordResetEmail } from "./types.ts";

function getEnvOrThrow(name: string): string {
  const val = Deno.env.get(name);
  if (!val) {
    throw new Error(
      `[email/tencent] ${name} 未配置，请检查环境变量`,
    );
  }
  return val;
}

/**
 * 发送密码重置邮件（腾讯云 SES）。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于邮件正文展示
 */
export const sendPasswordResetEmail: SendPasswordResetEmail = async (
  email: string,
  resetLink: string,
  _expiresInMinutes = 15,
) => {
  const secretId = getEnvOrThrow("TENCENT_SECRET_ID");
  const secretKey = getEnvOrThrow("TENCENT_SECRET_KEY");
  const fromEmail = getEnvOrThrow("TENCENT_FROM_EMAIL");
  const region = Deno.env.get("TENCENT_REGION") || "ap-guangzhou";

  // 动态导入腾讯云 SES SDK
  // deno-lint-ignore no-explicit-any
  const { ses }: any = await import("npm:tencentcloud-sdk-nodejs-ses@^4.1.247");

  const client = new ses.v20201002.Client({
    credential: {
      secretId,
      secretKey,
    },
    region,
    profile: {
      httpProfile: {
        endpoint: "ses.tencentcloudapi.com",
      },
    },
  });

  // 邮件正文 HTML
  const html = [
    `<p>您请求了密码重置。</p>`,
    `<p><a href="${resetLink}">点击此处重置密码</a></p>`,
    `<p>此链接 ${_expiresInMinutes} 分钟内有效。如非您本人操作，请忽略此邮件。</p>`,
  ].join("\n");

  await client.SendEmail({
    FromEmailAddress: fromEmail,
    Destination: [email],
    Subject: "重置您的 Neuro OJ 密码",
    Simple: {
      Html: btoa(html),
    },
  });
};
