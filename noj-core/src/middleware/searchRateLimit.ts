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
 * 触发限流时抛 RateLimitedError（含 X-RateLimit-* headers 和 Retry-After），
 * 由全局 onError 统一返回 429。
 */

import type { Context, MiddlewareHandler } from "hono";
import { getClientIp } from "../lib/rateLimitEnv.ts";
import { settingBool, settingInt } from "../lib/rateLimitEnv.ts";
import { RateLimitedError } from "../lib/errors.ts";
import { checkRateLimit, rateLimitHeaders } from "../lib/rateLimit.ts";

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

    const windowSec = settingInt("rate_limit_search_window");
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
      key = `search:user:${identifier}`;
    } else {
      identifier = getClientIp(c);
      key = `search:ip:${identifier}`;
    }

    const cfg = { windowSec, max };
    const result = await checkRateLimit(key, cfg);

    if (!result.allowed) {
      throw new RateLimitedError(
        "搜索请求过于频繁，请稍后再试",
        rateLimitHeaders(cfg, result),
      );
    }

    // 未触发限流也设置 X-RateLimit-Remaining 等头
    const headers = rateLimitHeaders(cfg, result);
    for (const [k, v] of Object.entries(headers)) {
      c.header(k, v);
    }

    await next();
  };
}
