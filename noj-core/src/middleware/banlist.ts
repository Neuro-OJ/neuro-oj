/**
 * IP 黑名单中间件（issue #102 / ban-status-endpoint）。
 *
 * 挂载在 authMiddleware 之前（app.ts 编排），让被 ban IP 第一时间被
 * 拦截，不消耗 JWT 验证 CPU。
 *
 * 方法限制 + 最小白名单：
 * - GET/HEAD/OPTIONS → 直接放行（被封 IP 可浏览页面、查 ban-status、登出）
 * - POST/PUT/PATCH/DELETE → 检查 IP 封禁，命中抛 403
 * - 白名单（logout + login）：两个 POST 端点豁免封禁检查
 *
 * 流程：
 * 1. getClientIp(c) 解析 X-Forwarded-For + TRUSTED_PROXIES 白名单
 * 2. method 检查 + 白名单检查
 * 3. getBannedRanges() 拉 ip_bans 列表（60s LRU 缓存，已过滤过期条目）
 * 4. isBannedIp(clientIp, ranges) CIDR 匹配
 * 5. 命中 → throw ForbiddenError("IP_BLACKLISTED")
 *
 * 无 clientIp（unknown）时放行：让 401 / 403 等正常错误路径不被堵死。
 */

import type { Context, Next } from "hono";
import { ForbiddenError } from "../lib/errors.ts";
import { getClientIp } from "../lib/rateLimitEnv.ts";
import { isBannedIp } from "../lib/cidr.ts";
import { getBannedRanges } from "../services/banlist.ts";

/** IP 黑名单中间件白名单——写操作中需要豁免的路径。 */
const WHITELIST: readonly string[] = [
  "/api/v1/auth/logout", // IP 被封用户仍可登出
  "/api/v1/auth/login", // IP 被封用户可提交密码（由 loginUser service 层 IP 检查拦截）
];

export async function banlistMiddleware(
  c: Context,
  next: Next,
): Promise<void> {
  const clientIp = getClientIp(c);
  if (clientIp === "unknown") {
    // 没解析到 IP（如本机直连）—— 放行
    return await next();
  }

  // 方法限制：非写操作放行
  if (
    c.req.method === "GET" || c.req.method === "HEAD" ||
    c.req.method === "OPTIONS"
  ) {
    return await next();
  }

  // 白名单：写操作但路径豁免
  if (WHITELIST.includes(c.req.path)) {
    return await next();
  }

  const ranges = await getBannedRanges();
  if (isBannedIp(clientIp, ranges)) {
    throw new ForbiddenError(
      "IP 已被加入黑名单",
      "IP_BLACKLISTED",
      { client_ip: clientIp },
    );
  }
  return await next();
}
