import { getSetting } from "../system-settings.ts";

/**
 * 读取系统设置中的字符串值，未配置时抛错。
 *
 * @param key 设置项 key
 * @param label 错误提示中的配置项名称
 * @returns 配置字符串
 * @throws {Error} 未配置时
 */
export function getSettingOrThrow(key: string, label: string): string {
  const val = getSetting(key);
  const str = typeof val?.value === "string" ? val.value : "";
  if (!str) {
    throw new Error(
      `[email] ${label} 未配置，请通过系统设置或环境变量配置`,
    );
  }
  return str;
}

/**
 * 构建密码重置邮件 HTML 正文。
 *
 * @param resetLink 完整的密码重置链接（含 token）
 * @param expiresInMinutes 过期时间（分钟）
 * @returns HTML 字符串
 */
export function buildResetPasswordHtml(
  resetLink: string,
  expiresInMinutes: number,
): string {
  return [
    `<p>您请求了密码重置。</p>`,
    `<p><a href="${resetLink}">点击此处重置密码</a></p>`,
    `<p>此链接 ${expiresInMinutes} 分钟内有效。如非您本人操作，请忽略此邮件。</p>`,
  ].join("\n");
}

/** 构建邮箱验证邮件 HTML 正文。 */
export function buildEmailVerificationHtml(
  verifyLink: string,
  expiresInMinutes: number,
): string {
  return [
    `<p>欢迎注册 Neuro OJ。</p>`,
    `<p><a href="${verifyLink}">点击此处验证邮箱</a></p>`,
    `<p>此链接 ${expiresInMinutes} 分钟内有效。如非您本人操作，请忽略此邮件。</p>`,
  ].join("\n");
}
