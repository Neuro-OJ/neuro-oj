/**
 * 邮件发送 Mock Provider。
 *
 * 默认行为：仅通过 logger 打印邮件内容。
 * 用于本地开发与 E2E 测试。
 */

import type { SendPasswordResetEmail } from "./types.ts";
import { logger } from "../logging.ts";

/**
 * 发送密码重置邮件（mock 模式）。
 *
 * @param email - 收件人邮箱
 * @param resetLink - 完整的密码重置链接（含 token）
 * @param expiresInMinutes - 过期时间（分钟），用于日志展示
 */
export const sendPasswordResetEmail: SendPasswordResetEmail = (
  email: string,
  resetLink: string,
  expiresInMinutes = 15,
) => {
  // mock 仅用于开发/测试：完整打印收件人与链接，便于本地取得重置链接
  logger.info("密码重置邮件（mock）", {
    module: "email-mock",
    event: "password_reset",
    to: email,
    link: resetLink,
    expiresIn: `${expiresInMinutes} minutes`,
  });
  return Promise.resolve();
};
