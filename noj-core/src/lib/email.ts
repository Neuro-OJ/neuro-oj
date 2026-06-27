/**
 * 邮件发送工具（issue #49，Phase 1 mock 实现）。
 *
 * 当前实现：仅在 stdout 打印完整记录。
 * 后续接 Resend / SMTP 时只改本文件 + 添加 RESEND_API_KEY 等环境变量。
 *
 * 安全考虑：
 * - token 仅在控制台日志中打印一次，URL 含明文（短期有效）
 * - 生产环境 `NOJ_ENV=production` 启用生产安全日志（UUID 截断、分值隐藏）
 *   不影响此 mock，但需注意生产日志收集链路不应持久化 link
 */

/**
 * 发送密码重置邮件（mock 模式）。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于日志展示
 */
export function sendPasswordResetEmail(
  email: string,
  resetLink: string,
  expiresInMinutes = 15,
): void {
  // TODO: 接入 Resend / SMTP 时改为 fetch 真实 API
  console.log(
    JSON.stringify({
      level: "info",
      module: "email-mock",
      event: "password_reset",
      to: email,
      link: resetLink,
      expiresIn: `${expiresInMinutes} minutes`,
    }),
  );
}
