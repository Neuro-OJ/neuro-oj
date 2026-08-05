/**
 * 通用速率限制器（issue #73）。
 *
 * 使用 Redis 固定窗口（INCR + EXPIRE）实现：
 * - 第一次 INCR 时设置过期时间
 * - 之后 INCR 累加计数
 * - 计数超过阈值时拒绝
 *
 * 固定窗口的边界突刺（窗口切换可双倍）问题在限流场景下可接受：
 * 攻击者最多在 2 倍时间窗口内通过 2 倍请求，远低于真实攻击流量。
 *
 * Redis 不可用时采用 **fail-closed**：抛出 ServiceUnavailableError (503)，
 * 避免 Redis 抖动时被绕过限流。
 */

import { getRedis } from "../mq/connection.ts";
import { ServiceUnavailableError } from "./errors.ts";

/** 时间窗口（秒） */
export interface RateLimitConfig {
  windowSec: number;
  /** 窗口内最大允许请求数 */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 时间戳（秒） */
  resetAt: number;
  /** 距离下次允许的秒数（0 表示已允许） */
  retryAfter: number;
}

const PREFIX = "ratelimit";

/**
 * 原子执行一次固定窗口计数检查。
 * 第一次 INCR 时设置 PEXPIRE。
 *
 * Redis 调用失败时抛 ServiceUnavailableError（fail-closed）。
 */
export async function checkRateLimit(
  key: string,
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const fullKey = `${PREFIX}:${key}`;
  const now = Date.now();
  const windowMs = cfg.windowSec * 1000;

  let count: number;
  let ttlMs: number;
  try {
    const pipe = redis.pipeline();
    pipe.incr(fullKey);
    pipe.pttl(fullKey);
    const results = await pipe.exec();
    // ioredis pipeline exec 返回 [err, value] 元组数组
    const incrErr = results[0]?.[0];
    if (incrErr) throw incrErr;
    count = results[0][1] as number;
    ttlMs = (results[1]?.[1] as number) ?? -1;

    // 首次 INCR（count=1）且无 TTL：设过期
    if (count === 1 || ttlMs < 0) {
      await redis.pexpire(fullKey, windowMs);
      ttlMs = windowMs;
    }
  } catch {
    // getRedis() 抛错（未初始化/已失败）或 pipeline 失败
    throw new ServiceUnavailableError("限流服务暂时不可用");
  }

  const allowed = count <= cfg.max;
  const resetAt = Math.floor((now + ttlMs) / 1000);

  return {
    allowed,
    remaining: Math.max(0, cfg.max - count),
    resetAt,
    retryAfter: allowed ? 0 : Math.ceil(ttlMs / 1000),
  };
}

/**
 * 标准 429 响应头。
 */
export function rateLimitHeaders(
  cfg: RateLimitConfig,
  result: RateLimitResult,
): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(cfg.max),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
    "Retry-After": String(result.retryAfter),
  };
}
