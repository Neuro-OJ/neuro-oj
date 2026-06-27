/**
 * 速率限制中间件（issue #73）。
 *
 * - IP 维度：挡机器（单 IP 暴力破解）
 * - 账号维度：挡分布式（多 IP 撞同一账号）
 *
 * 失败计数 + 锁定 + 退避见 src/lib/loginThrottle.ts，
 * 在路由层（routes/auth.ts）调用，service 层保持纯粹。
 */

import type { Context, Next } from "hono";
import { AppError } from "../lib/errors.ts";
import {
  checkRateLimit,
  type RateLimitConfig,
  rateLimitHeaders,
  type RateLimitResult,
} from "../lib/rateLimit.ts";

/** 限流 429 错误（继承 AppError，自动被 onError 捕获） */
class RateLimitedError extends AppError {
  headers: Record<string, string>;
  constructor(message: string, headers: Record<string, string>) {
    super(message, 429, "TOO_MANY_REQUESTS");
    this.name = "RateLimitedError";
    this.headers = headers;
  }
}

function envInt(name: string, def: number): number {
  const v = Deno.env.get(name);
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = Deno.env.get(name);
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

/** 限流总开关 */
export function isRateLimitEnabled(): boolean {
  if (Deno.env.get("NOJ_ENV") === "test") return false;
  return envBool("RATE_LIMIT_ENABLED", true);
}

// ── 默认限流配置（可被环境变量覆盖）────────────────────

export const LOGIN_LIMITS = {
  ip: {
    windowSec: envInt("RATE_LIMIT_LOGIN_IP_WINDOW", 30),
    max: envInt("RATE_LIMIT_LOGIN_IP_MAX", 10),
  },
  acc: {
    windowSec: envInt("RATE_LIMIT_LOGIN_ACC_WINDOW", 30),
    max: envInt("RATE_LIMIT_LOGIN_ACC_MAX", 5),
  },
} as const;

/** 解析客户端真实 IP：X-Forwarded-For 第一项（生产需配可信代理白名单） */
export function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0]!.trim();
  }
  return c.req.header("x-real-ip") || "unknown";
}

/**
 * IP 维度登录限流中间件（30s/10 次）。
 * 路由层在 body 解析后再做账号维度限流。
 */
export function loginIpRateLimit() {
  return async (c: Context, next: Next) => {
    if (!isRateLimitEnabled()) return next();

    const ip = getClientIp(c);
    const result = await checkRateLimit(`login:ip:${ip}`, LOGIN_LIMITS.ip);
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
 */
export async function checkLoginAccountRateLimit(
  login: string,
): Promise<RateLimitResult> {
  if (!isRateLimitEnabled()) {
    return { allowed: true, remaining: 0, resetAt: 0, retryAfter: 0 };
  }
  const key = (login || "anonymous").toLowerCase().slice(0, 64);
  return await checkRateLimit(`login:acc:${key}`, LOGIN_LIMITS.acc);
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
