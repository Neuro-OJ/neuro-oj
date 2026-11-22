/**
 * 阿里云 DirectMail 邮件发送 Provider。
 *
 * 使用 @alicloud/dm20151123 SDK 发送密码重置邮件。
 * 环境变量要求（EMAIL_PROVIDER=aliyun 时必填）：
 *   ALIBABA_ACCESS_KEY_ID
 *   ALIBABA_ACCESS_KEY_SECRET
 *   ALIBABA_FROM_EMAIL
 */

import type { SendEmail, SendPasswordResetEmail } from "./types.ts";
import { buildResetPasswordHtml, getSettingOrThrow } from "./common.ts";

/** SingleSendMail 请求参数（**camelCase**，由 SDK 模型映射为 wire 参数名）。 */
export interface AliyunSendMailParams {
  accountName: string;
  replyToAddress: boolean;
  addressType: number;
  toAddress: string;
  subject: string;
  htmlBody: string;
}

/**
 * 构造 SingleSendMail 请求参数。
 *
 * ⚠️ 字段名必须是 **camelCase**：`@alicloud/dm20151123` 的请求模型继承自
 * `$dara.Model`，只识别 camelCase 属性，再由模型自带的 `names()`
 * （`accountName → AccountName` 等）映射成 wire 参数。写成 PascalCase
 * （`AccountName: ...`）时构造器**静默丢弃全部字段**，服务端只报
 * `MissingAccountName: AccountName is mandatory for this action`——该报错看起来
 * 像发信地址没配置，实际是字段名不被识别（2026-09-26 生产实测）。
 *
 * 这类缺陷此前长期不可见：Provider 模块在 `deno compile` 产物里被排除
 * （见 email.ts 里 `PROVIDER_LOADERS` 的说明），这段请求从未真正发出过。
 *
 * @param fromEmail - 发信地址（ALIBABA_FROM_EMAIL）
 * @param toEmail - 收件人地址
 * @param subject - 邮件主题
 * @param html - 邮件 HTML 正文
 */
export function buildSendMailParams(
  fromEmail: string,
  toEmail: string,
  subject: string,
  html: string,
): AliyunSendMailParams {
  return {
    accountName: fromEmail,
    // 不单独指定回复地址（replyToAddress=true 会要求同时提供 ReplyAddress）
    replyToAddress: false,
    addressType: 1, // 1 = 发信地址（触发邮件），0 = 随机账号
    toAddress: toEmail,
    subject,
    htmlBody: html,
  };
}

/**
 * 发送密码重置邮件（阿里云 DirectMail）。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于邮件正文展示
 */
export const sendEmail: SendEmail = async (email, subject, html) => {
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

  const req = new SendMailRequest(
    buildSendMailParams(fromEmail, email, subject, html),
  );

  await client.singleSendMail(req);
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
