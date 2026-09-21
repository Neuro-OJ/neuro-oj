import type { Context, MiddlewareHandler } from "hono";
import { getClientIp, settingBool, settingInt } from "../../system/index.ts";
import { RateLimitedError } from "../../../shared/base/errors.ts";
import {
  checkRateLimit,
  rateLimitHeaders,
} from "../../../shared/rate-limit/rate-limit.ts";
import { checkPermission } from "../../identity/index.ts";

/**
 * 限流维度：
 * - `anon`：仅按来源 IP 计数；
 * - `authed`：仅按登录用户计数（无 userId 时直接放行）；
 * - `auto`：**按请求是否携带有效登录态自动选择**（路由实际使用）。
 *
 * `authed` 与 `auto` 的存在（2026-09-21 修复）：此前路由**永远**传 `"anon"`，
 * 于是已登录用户也按来源 IP 计数。在校园机房 / 企业 NAT 等"大量用户共享同一
 * 出口 IP"的环境下，匿名用户的搜索配额会被整栋楼共享，登录用户即便有独立的
 * 用户维度配额（`rate_limit_search_max_authed`，默认 30s/120 次）也拿不到，
 * 表现为"搜索功能突然不可用"。该用户维度此前是不可达的死配置——与
 * `CLAUDE.md`「登录用户 30s/120 次」的承诺不一致。
 *
 * `auto` 的语义：**登录用户只走用户桶，不再叠加 IP 桶**，否则共享出口 IP 的
 * 问题依旧存在。匿名请求仍按 IP 计数，未削弱对匿名滥用的防护。
 */
export type SearchRateLimitDimension = "anon" | "authed" | "auto";

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

    // 维度解析：auto 依据当前请求是否已通过 optionalAuth 注入 userId。
    const userId = c.get("userId") as string | undefined;
    const effective: "anon" | "authed" = dimension === "auto"
      ? (userId ? "authed" : "anon")
      : dimension;

    if (effective === "authed" && !userId) {
      // 显式 authed 模式但无登录态：不计数（与既有语义一致）。
      return next();
    }

    const windowSec = settingInt("rate_limit_search_window");
    const max = effective === "anon"
      ? settingInt("rate_limit_search_max_anon")
      : settingInt("rate_limit_search_max_authed");

    const key = effective === "authed"
      ? `search:user:${userId}`
      : `search:ip:${getClientIp(c)}`;

    const cfg = { windowSec, max };
    const result = await checkRateLimit(key, cfg);
    if (!result.allowed) {
      throw new RateLimitedError(
        `搜索请求过于频繁，请稍后再试（${
          effective === "anon" ? "IP" : "用户"
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
