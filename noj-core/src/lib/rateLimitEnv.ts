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
 *
 * 解析策略：
 * - XFF 存在 + TRUSTED_PROXIES 已配置：从右往左找第一个不在白名单的 IP（最接近客户端）
 * - XFF 存在 + TRUSTED_PROXIES **未配置**：仅在非生产环境下信任首项（开发友好）；
 *   生产环境下应**拒绝启动**（main.ts 启动校验，PR-7），fallback 仍写在此处
 *   以防御性返回 "unknown" 让上层走 unknown IP 分支（限流 / 审计仍工作）
 * - 否则用 X-Real-IP
 * - 都没有则返回 "unknown"
 *
 * ## PR-7 安全说明
 *
 * 未配置 TRUSTED_PROXIES 时返回 XFF 首项是历史行为，会被攻击者通过
 * `X-Forwarded-For: 1.2.3.4` 绕过 IP 限流 / IP 黑名单。
 * PR-7 修复：生产环境（NOJ_ENV=production）启动时若 TRUSTED_PROXIES 为空
 * 直接 Deno.exit(1)，不让进程进入这种不安全状态。
 *
 * @param c Hono Context
 * @returns 客户端 IP 字符串，无法解析时为 "unknown"
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
    // 未配置白名单：
    // - 生产环境：main.ts 启动校验应已 Deno.exit(1)，此处 defensive 返 unknown
    // - 非生产（开发/测试）：保持历史行为信任首项，开发者本地调试友好
    if (Deno.env.get("NOJ_ENV") === "production") {
      console.warn(
        "[security] 生产环境运行但 TRUSTED_PROXIES 未配置，XFF 首项不可信 → 返 unknown。" +
          "（main.ts 启动校验应已阻止进入此分支）",
      );
      return "unknown";
    }
    return ips[0] ?? "unknown";
  }
  return c.req.header("x-real-ip") || "unknown";
}
