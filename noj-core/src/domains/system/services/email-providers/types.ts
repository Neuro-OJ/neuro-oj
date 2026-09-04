/**
 * 邮件 Provider 统一类型定义。
 *
 * 所有邮件发送 Provider MUST 实现此接口。
 */

/**
 * 密码重置邮件发送函数签名。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于邮件正文展示
 */
export type SendPasswordResetEmail = (
  email: string,
  resetLink: string,
  expiresInMinutes?: number,
) => Promise<void>;
