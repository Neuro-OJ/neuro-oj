/**
 * 搜索限流中间件（issue #100）。
 *
 * 与登录限流共享 Redis 固定窗口计数模式，但桶命名空间独立：
 * - 匿名 IP: ratelimit:search:ip:<ip>
 * - 登录用户: ratelimit:search:user:<user_id>
 *
 * 阈值通过 settings-registry 配置（rate_limit_search_*），运行时可调。
 * Admin 不受限流（user_role === 'admin' 时跳过）。
 *
 * 触发限流时抛 RateLimitError（含 X-RateLimit-* headers），由全局 onError 统一返回 429。
 */

import type { Context, MiddlewareHandler } from "hono";
import { getRedis } from "../mq/connection.ts";
import { getClientIp } from "../lib/rateLimitEnv.ts";
import { settingBool, settingInt } from "../lib/rateLimitEnv.ts";
import { RateLimitError } from "../lib/errors.ts";

export type SearchRateLimitDimension = "anon" | "authed";

/**
 * 构造搜索限流中间件。
 *
 * @param dimension 限流维度（anon = IP 桶，authed = 用户桶）
 */
export function searchRateLimit(
  dimension: SearchRateLimitDimension,
): MiddlewareHandler {
  return async (c: Context, next) => {
    // 总开关
    if (!settingBool("rate_limit_search_enabled")) {
      return await next();
    }

    // 管理员跳过限流
    const role = c.get("userRole");
    if (role === "admin") {
      return await next();
    }

    const window = settingInt("rate_limit_search_window");
    const max = dimension === "anon"
      ? settingInt("rate_limit_search_max_anon")
      : settingInt("rate_limit_search_max_authed");

    // 维度对应 key
    let key: string;
    let identifier: string;
    if (dimension === "authed") {
      const userId = c.get("userId");
      if (!userId) {
        // 登录维度的中间件要求已登录，理论上 authMiddleware 在前已保证
        return await next();
      }
      identifier = userId;
      key = `ratelimit:search:user:${identifier}`;
    } else {
      identifier = getClientIp(c);
      key = `ratelimit:search:ip:${identifier}`;
    }

    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, window);
    }

    const remaining = Math.max(0, max - count);
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));

    if (count > max) {
      const ttl = await redis.ttl(key);
      const resetAt = Math.floor(Date.now() / 1000) + (ttl > 0 ? ttl : window);
      c.header("X-RateLimit-Reset", String(resetAt));
      c.header("Retry-After", String(ttl > 0 ? ttl : window));
      throw new RateLimitError(
        `搜索请求过于频繁，请稍后再试（${
          dimension === "anon" ? "IP" : "用户"
        }维度）`,
        { retry_after: ttl > 0 ? ttl : window },
      );
    }

    await next();
  };
}
