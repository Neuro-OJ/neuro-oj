import type { Context, Next } from "hono";
import { isRateLimitEnabled } from "../lib/rateLimitEnv.ts";

/**
 * 滑动窗口限流中间件（内存版）。
 *
 * 设计目标：
 * - 不引入 Redis 依赖，纯进程内 Map 实现（部署多实例时各自限流，整体仍受控）
 * - 区分登录与未登录用户：登录按 userId，未登录按 IP
 * - 防止内存泄漏：超过 60s 的时间戳自动清理；超过上限的 key 全部丢弃
 *
 * 用法：
 *   router.get("/public/recent", rateLimit({ loggedInIntervalMs: 1000, loggedOutIntervalMs: 5000 }), handler)
 *
 * 行为：
 * - 登录用户：两次请求至少间隔 loggedInIntervalMs
 * - 未登录用户：两次请求至少间隔 loggedOutIntervalMs
 * - 触发限流时返回 429 Too Many Requests
 */

interface RateLimitOptions {
  /** 登录用户两次请求的最小间隔（毫秒） */
  loggedInIntervalMs: number;
  /** 未登录用户两次请求的最小间隔（毫秒） */
  loggedOutIntervalMs: number;
}

const trackedRequests = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 10_000;

function getClientKey(c: Context): { key: string; isLoggedIn: boolean } {
  const path = c.req.path;
  const userId = c.get("userId");
  if (userId) {
    return { key: `${path}:user:${userId}`, isLoggedIn: true };
  }
  // IP 提取策略：
  // 1. X-Real-IP 优先——反向代理设置的实际客户端 IP，不受客户端伪造影响
  // 2. X-Forwarded-For 取最后一项——代理链中最后添加的 IP 最可信
  // 3. 兜底 fallback 到 "unknown"
  // 注意：仅信任明确配置的反向代理剥离 X-Forwarded-For 的环境
  const realIp = c.req.header("x-real-ip");
  if (realIp) {
    return { key: `${path}:ip:${realIp}`, isLoggedIn: false };
  }
  const xff = c.req.header("x-forwarded-for");
  const ips = xff?.split(",").map((s) => s.trim()).filter(Boolean);
  const ip = ips?.[ips.length - 1] || "unknown";
  return { key: `${path}:ip:${ip}`, isLoggedIn: false };
}

function checkAndRecord(key: string, intervalMs: number): boolean {
  const now = Date.now();
  const timestamps = trackedRequests.get(key) ?? [];
  // 清理窗口外的时间戳
  const recent = timestamps.filter((t) => now - t < intervalMs);

  if (recent.length > 0 && now - recent[recent.length - 1] < intervalMs) {
    // 仍在窗口内且未到间隔：拒绝
    trackedRequests.set(key, recent);
    return false;
  }

  recent.push(now);
  trackedRequests.set(key, recent);

  // 防止内存无限增长：超过阈值时先尝试过期清理，仍超则随机驱逐
  if (trackedRequests.size > MAX_TRACKED_KEYS) {
    for (const [k, ts] of trackedRequests) {
      if (ts.length === 0 || now - ts[ts.length - 1] > 60_000) {
        trackedRequests.delete(k);
      }
    }
    // 如果清理后仍超上限，随机移除 10% 的 key（避免 O(N) 全量遍历）
    if (trackedRequests.size > MAX_TRACKED_KEYS) {
      const keysToDelete = Math.ceil(trackedRequests.size * 0.1);
      const keys = [...trackedRequests.keys()];
      for (let i = 0; i < keysToDelete && i < keys.length; i++) {
        trackedRequests.delete(keys[i]);
      }
    }
  }
  return true;
}

/** 测试辅助：重置所有限流记录（生产环境不应调用）。 */
export function _resetRateLimitForTests(): void {
  trackedRequests.clear();
}

export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    if (!isRateLimitEnabled()) {
      await next();
      return;
    }
    const { key, isLoggedIn } = getClientKey(c);
    const intervalMs = isLoggedIn
      ? opts.loggedInIntervalMs
      : opts.loggedOutIntervalMs;

    if (!checkAndRecord(key, intervalMs)) {
      const retryAfterSec = Math.ceil(intervalMs / 1000);
      c.header("Retry-After", String(retryAfterSec));
      return c.json({
        error: "请求过于频繁，请稍后再试",
        retry_after: retryAfterSec,
      }, 429);
    }

    await next();
  };
}
