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
import { getSetting } from "../system-settings.ts";
import { buildResetPasswordHtml, getSettingOrThrow } from "./common.ts";

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
  const secretId = getSettingOrThrow("tencent_secret_id", "腾讯云 SecretId");
  const secretKey = getSettingOrThrow("tencent_secret_key", "腾讯云 SecretKey");
  const fromEmail = getSettingOrThrow("tencent_from_email", "腾讯云发信地址");
  const region = String(getSetting("tencent_region")?.value ?? "ap-guangzhou");

  // 动态导入腾讯云 SES SDK
  // deno-lint-ignore no-explicit-any
  const { ses }: any = await import("tencentcloud-sdk-nodejs-ses");

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
  const html = buildResetPasswordHtml(resetLink, _expiresInMinutes);

  await client.SendEmail({
    FromEmailAddress: fromEmail,
    Destination: [email],
    Subject: "重置您的 Neuro OJ 密码",
    Simple: {
      Html: btoa(html),
    },
  });
};
