/**
 * 速率限制中间件（issue #73）。
 *
 * - IP 维度：挡机器（单 IP 暴力破解）
 * - 账号维度：挡分布式（多 IP 撞同一账号）
 *
 * 失败计数 + 锁定 + 退避见 src/lib/loginThrottle.ts，
 * 在路由层（routes/auth.ts）调用，service 层保持纯粹。
 *
 * envInt/envBool/isRateLimitEnabled/getClientIp 统一在
 * src/lib/rateLimitEnv.ts 定义（DRY）。
 */

import type { Context, Next } from "hono";
import { eq, or } from "drizzle-orm";
import { getDb } from "./../shared/db/connection.ts";
import { users } from "./../shared/db/schema.ts";
import { RateLimitedError } from "./../shared/base/errors.ts";
import {
  checkRateLimit,
  type RateLimitConfig,
  rateLimitHeaders,
  type RateLimitResult,
} from "./../shared/rate-limit/rate-limit.ts";
import {
  getClientIp,
  isRateLimitEnabled,
  settingInt,
} from "../domains/system/index.ts";

// ── 默认限流配置（可被环境变量覆盖） ────────────────────

export const LOGIN_LIMITS = {
  get ip() {
    return {
      windowSec: settingInt("rate_limit_login_ip_window"),
      max: settingInt("rate_limit_login_ip_max"),
    };
  },
  get acc() {
    return {
      windowSec: settingInt("rate_limit_login_acc_window"),
      max: settingInt("rate_limit_login_acc_max"),
    };
  },
};

/**
 * IP 维度登录限流中间件（30s/10 次）。
 * 路由层在 body 解析后再做账号维度限流。
 *
 * namespace 参数（评审修复 M3）：用于区分登录端点与改密端点的限流桶，
 * 避免 `/api/v1/auth/change-password` 失败反锁 `/api/v1/auth/login`。
 * 默认 "login"，改密端点传 "pwchange"。
 *
 * Redis 不可用时由 checkRateLimit 内部抛 ServiceUnavailableError（503）。
 */
export function loginIpRateLimit(namespace: string = "login") {
  return async (c: Context, next: Next) => {
    if (!isRateLimitEnabled()) return next();

    const ip = getClientIp(c);
    const result = await checkRateLimit(
      `${namespace}:ip:${ip}`,
      LOGIN_LIMITS.ip,
    );
    if (!result.allowed) {
      throw new RateLimitedError(
        "请求过于频繁，请稍后重试",
        rateLimitHeaders(LOGIN_LIMITS.ip, result),
      );
    }
    await next();
  };
}

/**
 * 账号维度限流（需在路由层 body 解析后调用）。
 * 返回 RateLimitResult 供路由层决定 429 响应。
 *
 * namespace 参数（评审修复 M3）：与 loginIpRateLimit 对齐，确保
 * 改密失败只计入 pwchange 限流桶，不污染登录限流桶。
 */
export async function checkLoginAccountRateLimit(
  login: string,
  namespace: string = "login",
): Promise<RateLimitResult> {
  if (!isRateLimitEnabled()) {
    return { allowed: true, remaining: 0, resetAt: 0, retryAfter: 0 };
  }
  const key = await resolveLoginAccountKey(login);
  return checkRateLimit(`${namespace}:acc:${key}`, LOGIN_LIMITS.acc);
}

/**
 * NOJ-092：账号维度限流 key 统一规范化为 users.id。
 * 用户名/邮箱登录指向同一账号时共享限流与锁定桶，
 * 避免攻击者用 `user@example.com` / `username` 交替绕过。
 * 不存在的账号回退到规范化 login（仍限流，但不泄露账号存在性）。
 */
export async function resolveLoginAccountKey(login: string): Promise<string> {
  const fallback = (login || "anonymous").toLowerCase().slice(0, 64);
  try {
    const db = getDb();
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.username, login), eq(users.email, login)))
      .limit(1);
    return rows[0]?.id ?? `unknown:${fallback}`;
  } catch {
    return `unknown:${fallback}`;
  }
}
/** 429 抛错器供路由层使用 */
export function throwRateLimited(
  cfg: RateLimitConfig,
  result: RateLimitResult,
) {
  throw new RateLimitedError(
    "请求过于频繁，请稍后重试",
    rateLimitHeaders(cfg, result),
  );
}
