/**
 * 邮件发送入口。
 *
 * 根据环境变量 EMAIL_PROVIDER 动态选择 Provider：
 * - mock（默认）：仅控制台日志输出
 * - aliyun：阿里云 DirectMail
 * - tencent：腾讯云 SES
 *
 * 启动时在 main.ts 中校验 Provider 环境变量完整性，缺失时降级到 mock。
 */

import type { SendPasswordResetEmail } from "./email-providers/types.ts";
import { getSetting } from "../services/system-settings.ts";
import { logger } from "./logging.ts";

/** Provider 名称到模块路径的映射 */
const PROVIDER_MODULES: Record<string, string> = {
  mock: "./email-providers/mock.ts",
  aliyun: "./email-providers/aliyun.ts",
  tencent: "./email-providers/tencent.ts",
};

/** 已缓存的 send 函数引用 */
let sendFn: SendPasswordResetEmail | null = null;

/**
 * 加载当前 EMAIL_PROVIDER 对应的发送函数。
 *
 * 在首次调用时动态导入，后续调用复用缓存。设计上允许 main.ts 在启动时
 * 通过 setEmailProvider() 覆盖 provider 选择（例如降级时）。
 */
async function loadSendFn(): Promise<SendPasswordResetEmail> {
  if (sendFn) return sendFn;

  const provider = String(getSetting("email_provider")?.value ?? "mock");
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
