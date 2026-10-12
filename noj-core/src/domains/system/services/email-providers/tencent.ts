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

import type { SendEmail, SendPasswordResetEmail } from "./types.ts";
import { getSetting } from "../system-settings.ts";
import { buildResetPasswordHtml, getSettingOrThrow } from "./common.ts";
import { encodeBase64 } from "@std/encoding/base64";

/**
 * 把 HTML 正文编码为腾讯云 SES 要求的 base64。
 *
 * ⚠️ 不能用 `btoa(html)`：`btoa` 只接受 Latin-1 字符，而本站邮件模板正文含中文
 * （`buildResetPasswordHtml` / `buildEmailVerificationHtml`），调用会抛
 * `InvalidCharacterError: The string to be encoded contains characters outside of
 * the Latin1 range`——邮件永远发不出去，且错误发生在本地编码阶段（2026-09-26 由
 * aliyun 侧同类"从未被执行过"缺陷顺带发现；腾讯云通道当前无凭据，仅静态验证）。
 *
 * @param html - HTML 正文
 * @returns UTF-8 字节的 base64 字符串
 */
export function encodeHtmlBase64(html: string): string {
  return encodeBase64(new TextEncoder().encode(html));
}

/**
 * 发送密码重置邮件（腾讯云 SES）。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于邮件正文展示
 */
export const sendEmail: SendEmail = async (email, subject, html) => {
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

  await client.SendEmail({
    FromEmailAddress: fromEmail,
    Destination: [email],
    Subject: subject,
    Simple: {
      Html: encodeHtmlBase64(html),
    },
  });
  return true;
};

export const sendPasswordResetEmail: SendPasswordResetEmail = async (
  email,
  resetLink,
  expiresInMinutes = 15,
) => {
  await sendEmail(
    email,
    "重置您的 Neuro OJ 密码",
    buildResetPasswordHtml(resetLink, expiresInMinutes),
  );
};
