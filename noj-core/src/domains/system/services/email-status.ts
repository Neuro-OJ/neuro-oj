/**
 * 邮件服务就绪状态（issue #426）。
 *
 * EMAIL_PROVIDER=disabled 允许站点启动，但邮箱验证与密码找回不可用；
 * 新用户 email_verified=false 而提交/社区/私信写操作要求已验证邮箱，
 * 未配置邮件时继续开放公开注册会形成"注册成功但无法完成验证"的死路。
 *
 * 该模块统一回答"邮件是否已就绪"：
 * - disabled：未就绪；
 * - mock：仅非生产环境视为就绪（生产禁止 mock 发送）；
 * - aliyun / tencent：必需配置全部非空才视为就绪。
 */

import { getSetting } from "./system-settings.ts";
import { EMAIL_PROVIDER_REQUIRED_SETTINGS } from "../../../shared/config/production-config.ts";

export interface EmailConfigStatus {
  /** 当前 email_provider 设置值（缺失时回退默认 mock）。 */
  provider: string;
  /** 是否已就绪：可以真实完成邮箱验证与密码找回邮件发送。 */
  configured: boolean;
  /** 未就绪时缺失的 .env 配置项（env 变量名，供管理后台展示）。 */
  missing: string[];
}

/** 读取当前邮件 Provider 配置并判断是否就绪。 */
export function getEmailConfigStatus(): EmailConfigStatus {
  const provider = String(getSetting("email_provider")?.value ?? "mock");

  if (provider === "disabled") {
    return { provider, configured: false, missing: ["EMAIL_PROVIDER"] };
  }

  if (provider === "mock") {
    const production = Deno.env.get("NOJ_ENV") === "production";
    return {
      provider,
      configured: !production,
      missing: production ? ["EMAIL_PROVIDER"] : [],
    };
  }

  const required = EMAIL_PROVIDER_REQUIRED_SETTINGS[
    provider as "aliyun" | "tencent"
  ];
  if (!required) {
    return { provider, configured: false, missing: ["EMAIL_PROVIDER"] };
  }

  const missing = required
    .filter(([, settingKey]) =>
      !String(getSetting(settingKey)?.value ?? "").trim()
    )
    .map(([envKey]) => envKey);
  return { provider, configured: missing.length === 0, missing };
}
