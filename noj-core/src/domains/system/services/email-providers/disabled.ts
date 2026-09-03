/**
 * 已关闭的邮件服务。
 *
 * 该模式用于尚未配置邮件服务的生产环境。不能记录密码重置链接，避免
 * 用户误以为已经发送邮件，也避免把重置令牌写入日志。
 */

import type { SendPasswordResetEmail } from "./types.ts";
import { logger } from "../../../../shared/base/logging.ts";

export const sendPasswordResetEmail: SendPasswordResetEmail = () => {
  logger.warn("邮件服务未配置，跳过密码找回邮件", {
    module: "email-disabled",
    event: "password_reset_skipped",
  });
  return Promise.resolve();
};
