/**
 * 邮件发送入口。
 *
 * 根据环境变量 EMAIL_PROVIDER 动态选择 Provider：
 * - disabled：关闭邮件发送
 * - mock（默认）：仅控制台日志输出
 * - aliyun：阿里云 DirectMail
 * - tencent：腾讯云 SES
 *
 * 启动时在 main.ts 中校验 Provider 环境变量完整性；生产环境可以显式关闭邮件。
 */

import type {
  SendEmail,
  SendPasswordResetEmail,
} from "./email-providers/types.ts";
import { buildEmailVerificationHtml } from "./email-providers/common.ts";
import { getSetting } from "./system-settings.ts";
import { logger } from "../../../shared/base/logging.ts";

/** Provider 名称到模块路径的映射 */
const PROVIDER_MODULES: Record<string, string> = {
  disabled: "./email-providers/disabled.ts",
  mock: "./email-providers/mock.ts",
  aliyun: "./email-providers/aliyun.ts",
  tencent: "./email-providers/tencent.ts",
};

/** 已缓存的 send 函数引用 */
let sendFn: SendPasswordResetEmail | null = null;
let sendEmailFn: SendEmail | null = null;

/**
 * 加载当前 EMAIL_PROVIDER 对应的发送函数。
 *
 * 在首次调用时动态导入，后续调用复用缓存。设计上允许 main.ts 在启动时
 * 通过 setEmailProvider() 覆盖 provider 选择（例如降级时）。
 */
async function loadSendFn(): Promise<SendPasswordResetEmail> {
  if (sendFn) return sendFn;

  const provider = String(getSetting("email_provider")?.value ?? "mock");

  if (
    Deno.env.get("NOJ_ENV") === "production" &&
    (provider === "mock" || !PROVIDER_MODULES[provider])
  ) {
    throw new Error(
      "生产环境禁止使用 mock 邮件 Provider；请配置 email_provider=aliyun、tencent 或 disabled",
    );
  }

  const modulePath = PROVIDER_MODULES[provider];

  if (!modulePath) {
    logger.warn("未知的 EMAIL_PROVIDER，使用 mock 替代", { provider });
    Deno.env.set("EMAIL_PROVIDER", "mock");
    const mod = await import("./email-providers/mock.ts");
    sendFn = mod.sendPasswordResetEmail;
    return sendFn!;
  }

  const mod = await import(modulePath);
  sendFn = mod.sendPasswordResetEmail;
  return sendFn!;
}

/**
 * 重置缓存的 Provider 函数。
 *
 * 用于 main.ts 降级时强制重新加载。
 */
export function resetEmailProvider(): void {
  sendFn = null;
  sendEmailFn = null;
}

async function loadGenericSendFn(): Promise<SendEmail> {
  if (sendEmailFn) return sendEmailFn;
  const provider = String(getSetting("email_provider")?.value ?? "mock");
  const modulePath = PROVIDER_MODULES[provider];
  if (!modulePath) {
    throw new Error(`未知的 EMAIL_PROVIDER：${provider}`);
  }
  if (Deno.env.get("NOJ_ENV") === "production" && provider === "mock") {
    throw new Error("生产环境禁止使用 mock 邮件 Provider");
  }
  const mod = await import(modulePath);
  sendEmailFn = mod.sendEmail;
  return sendEmailFn!;
}

/**
 * 发送密码重置邮件。
 *
 * 根据环境变量 EMAIL_PROVIDER 自动选择底层实现。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟）
 */
export async function sendPasswordResetEmail(
  email: string,
  resetLink: string,
  expiresInMinutes = 15,
): Promise<void> {
  const fn = await loadSendFn();
  await fn(email, resetLink, expiresInMinutes);
}

/** 发送邮箱验证邮件。 */
export async function sendEmailVerificationEmail(
  email: string,
  verifyLink: string,
  expiresInMinutes = 30,
): Promise<boolean> {
  const fn = await loadGenericSendFn();
  return await fn(
    email,
    "验证您的 Neuro OJ 邮箱",
    buildEmailVerificationHtml(verifyLink, expiresInMinutes),
  );
}

/**
 * 发送管理后台测试邮件（issue #426）。
 *
 * 供管理员在开放公开注册前验证邮件配置是否真实可用；
 * disabled Provider 会返回 false，临时故障由调用方捕获并反馈。
 */
export async function sendTestEmail(to: string): Promise<boolean> {
  const fn = await loadGenericSendFn();
  return await fn(
    to,
    "Neuro OJ 测试邮件",
    "<p>这是一封来自 Neuro OJ 管理后台的测试邮件。</p>" +
      "<p>收到此邮件说明当前邮件服务配置可用，可以开放公开注册。</p>",
  );
}
