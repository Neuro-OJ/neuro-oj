/**
 * 审计修复（NOJ-093/094/096/069）使用的高风险端点限流。
 *
 * 与登录限流一样走 Redis 固定窗口，并在 Redis 不可用时 fail-closed（503）。
 * 阈值故意保持宽松以兼容现有 API 客户端，同时阻止无差别批量刷接口。
 */

import { RateLimitedError } from "./errors.ts";
import {
  checkRateLimit,
  type RateLimitConfig,
  rateLimitHeaders,
} from "./rate-limit.ts";
import { getClientIp, isRateLimitEnabled } from "./rate-limit-env.ts";
import type { Context } from "hono";

export const REGISTER_LIMIT: RateLimitConfig = {
  windowSec: 3600,
  max: 100,
};

export const PASSWORD_RESET_IP_LIMIT: RateLimitConfig = {
  windowSec: 3600,
  max: 30,
};

export const PASSWORD_RESET_EMAIL_LIMIT: RateLimitConfig = {
  windowSec: 3600,
  max: 10,
};

export const MESSAGE_SEND_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 60,
};

export const SUBMISSION_IP_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

export const SUBMISSION_USER_LIMIT: RateLimitConfig = {
  windowSec: 60,
  max: 120,
};

function normalizeLimitKey(value: string): string {
  return value.trim().toLowerCase().slice(0, 128);
}

export async function enforceRateLimit(
  key: string,
  cfg: RateLimitConfig,
  message = "请求过于频繁，请稍后重试",
): Promise<void> {
  if (!isRateLimitEnabled()) return;
  const result = await checkRateLimit(
    `hardening:${normalizeLimitKey(key)}`,
    cfg,
  );
  if (!result.allowed) {
    throw new RateLimitedError(message, rateLimitHeaders(cfg, result));
  }
}

/** 注册端点：按客户端 IP 限流。 */
export async function enforceRegisterRateLimit(c: Context): Promise<void> {
  await enforceRateLimit(
    `register:ip:${getClientIp(c)}`,
    REGISTER_LIMIT,
    "注册过于频繁，请稍后重试",
  );
}

/** 忘记/重置密码：IP 维度。 */
export async function enforcePasswordResetIpRateLimit(
  c: Context,
): Promise<void> {
  await enforceRateLimit(
    `password-reset:ip:${getClientIp(c)}`,
    PASSWORD_RESET_IP_LIMIT,
  );
}

/** 忘记/重置密码：邮箱维度（防止对单个邮箱轰炸）。 */
export async function enforcePasswordResetEmailRateLimit(
  email: string,
): Promise<void> {
  await enforceRateLimit(
    `password-reset:email:${email}`,
    PASSWORD_RESET_EMAIL_LIMIT,
  );
}

/** 私信发送：按发送用户维度。 */
export async function enforceMessageSendRateLimit(
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `message:user:${userId}`,
    MESSAGE_SEND_LIMIT,
  );
}

/** 提交创建：IP + 用户双维度。 */
export async function enforceSubmissionRateLimit(
  c: Context,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `submission:ip:${getClientIp(c)}`,
    SUBMISSION_IP_LIMIT,
  );
  await enforceRateLimit(
    `submission:user:${userId}`,
    SUBMISSION_USER_LIMIT,
  );
}
