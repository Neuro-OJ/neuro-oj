import type { Context, MiddlewareHandler } from "hono";
import { getClientIp, settingBool, settingInt } from "../../system/index.ts";
import { RateLimitedError } from "../../../shared/base/errors.ts";
import {
  checkRateLimit,
  rateLimitHeaders,
} from "../../../shared/rate-limit/rate-limit.ts";
import { checkPermission } from "../../identity/index.ts";

export type SearchRateLimitDimension = "anon" | "authed";

export function searchRateLimit(
  dimension: SearchRateLimitDimension,
): MiddlewareHandler {
  return async (c: Context, next) => {
    if (!settingBool("rate_limit_search_enabled")) {
      return next();
    }
    if (await checkPermission(c, "admin:full_access")) {
      return next();
    }
    const windowSec = settingInt("rate_limit_search_window");
    const max = dimension === "anon"
      ? settingInt("rate_limit_search_max_anon")
      : settingInt("rate_limit_search_max_authed");
    let key: string;
    let identifier: string;
    if (dimension === "authed") {
      const userId = c.get("userId");
      if (!userId) return next();
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
        `搜索请求过于频繁，请稍后再试（${
          dimension === "anon" ? "IP" : "用户"
        }维度）`,
        rateLimitHeaders(cfg, result),
      );
    }
    const headers = rateLimitHeaders(cfg, result);
    for (const [k, v] of Object.entries(headers)) {
      c.header(k, v);
    }
    await next();
  };
}
