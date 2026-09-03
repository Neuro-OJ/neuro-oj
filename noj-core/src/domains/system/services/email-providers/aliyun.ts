/**
 * 阿里云 DirectMail 邮件发送 Provider。
 *
 * 使用 @alicloud/dm20151123 SDK 发送密码重置邮件。
 * 环境变量要求（EMAIL_PROVIDER=aliyun 时必填）：
 *   ALIBABA_ACCESS_KEY_ID
 *   ALIBABA_ACCESS_KEY_SECRET
 *   ALIBABA_FROM_EMAIL
 */

import type { SendPasswordResetEmail } from "./types.ts";
import { buildResetPasswordHtml, getSettingOrThrow } from "./common.ts";

/**
 * 发送密码重置邮件（阿里云 DirectMail）。
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
  const akId = getSettingOrThrow(
    "alibaba_access_key_id",
    "阿里云 AccessKey ID",
  );
  const akSecret = getSettingOrThrow(
    "alibaba_access_key_secret",
    "阿里云 AccessKey Secret",
  );
  const fromEmail = getSettingOrThrow("alibaba_from_email", "阿里云发信地址");

  // 动态导入 SDK（CJS/ESM 互操作）
  // deno-lint-ignore no-explicit-any
  const DMMod: any = await import("npm:@alicloud/dm20151123@^1.10.2");
  // deno-lint-ignore no-explicit-any
  const OApi: any = await import("@alicloud/openapi-core");

  const DMClient = DMMod["module.exports"].default;
  const ConfigClass = OApi["$OpenApiUtil"].Config;
  const SendMailRequest = DMMod.SingleSendMailRequest;

  const config = new ConfigClass({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: "dm.aliyuncs.com",
  });

  const client = new DMClient(config);

  const req = new SendMailRequest({
    AccountName: fromEmail,
    ToAddress: email,
    Subject: "重置您的 Neuro OJ 密码",
    HtmlBody: buildResetPasswordHtml(resetLink, _expiresInMinutes),
    AddressType: 1, // 触发邮件
  });

  await client.singleSendMail(req);
};
