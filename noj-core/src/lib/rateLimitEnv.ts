/**
 * 限流共享配置（issue #73）。
 *
 * 集中 envInt/envBool/总开关 + 可信代理白名单，避免在
 * lib/loginThrottle.ts 与 middleware/rateLimit.ts 重复定义。
 *
 * 可信代理语义：
 * - 未配置 TRUSTED_PROXIES：开发环境友好，XFF 首项即客户端 IP
 * - 已配置：从 XFF 链**从右往左**找第一个不在白名单的 IP（即"最接近客户端"的非代理 IP）
 *   - 若全部都在白名单内，视为无客户端 IP，返回 "unknown"
 *   - 这是反向代理多层链路下提取真实客户端的标准做法
 */

import type { Context } from "hono";
import { getSetting } from "../services/system-settings.ts";
import { findDefinition } from "./settings-registry.ts";

/** 读取整数环境变量（非正数或 NaN 时回退默认值） */
export function envInt(name: string, def: number): number {
  const v = Deno.env.get(name);
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** 从 DB-backed 设置读取整数（通过 getSetting），回退至注册表 default */
export function settingInt(key: string): number {
  const s = getSetting(key);
  if (s?.value !== undefined && typeof s.value === "number") {
    return s.value;
  }
  const def = findDefinition(key);
  return typeof def?.default === "number" ? def.default : 0;
}

/** 读取布尔环境变量（"true"/"1" 视为 true；undefined 时回退默认） */
export function envBool(name: string, def: boolean): boolean {
  const v = Deno.env.get(name);
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

/** 从 DB-backed 设置读取布尔值（通过 getSetting），回退至注册表 default */
export function settingBool(key: string): boolean {
  const s = getSetting(key);
  if (s?.value !== undefined && typeof s.value === "boolean") {
    return s.value;
  }
  const def = findDefinition(key);
  return typeof def?.default === "boolean" ? def.default : true;
}

/** 限流总开关。NOJ_ENV=test 时默认禁用，但 RATE_LIMIT_ENABLED=true 可覆盖。 */
export function isRateLimitEnabled(): boolean {
  if (Deno.env.get("NOJ_ENV") === "test") {
    // 测试模式下默认关闭，但允许测试文件主动开启
    return envBool("RATE_LIMIT_ENABLED", false);
  }
  return settingBool("rate_limit_enabled");
}

/** 解析可信代理，逗号分隔。不再缓存（DB-backed 值可运行时变更）。 */
export function getTrustedProxies(): string[] {
  const setting = getSetting("trusted_proxies");
  const v = typeof setting?.value === "string" ? setting.value : "";
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * 解析客户端真实 IP。
 * 解析客户端真实 IP。
 * - XFF 存在时按白名单规则取最左侧的非代理 IP
 * - 否则用 X-Real-IP
 * - 都没有则返回 "unknown"
 */
export function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const ips = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const trusted = getTrustedProxies();
    if (trusted.length > 0) {
      // 从右往左（最接近客户端的代理）找第一个不在白名单的 IP
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!trusted.includes(ips[i]!)) return ips[i]!;
      }
      return "unknown";
    }
    // 未配置白名单：开发友好模式，信任首项
    return ips[0] ?? "unknown";
  }
  return c.req.header("x-real-ip") || "unknown";
}
