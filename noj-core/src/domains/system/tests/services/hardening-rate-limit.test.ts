/**
 * hardening 限流配置与基础行为测试。
 *
 * 不依赖 DB；限流基础行为依赖 Redis（无 Redis 时跳过）。
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  BOOKMARK_IP_LIMIT,
  BOOKMARK_USER_LIMIT,
  COMMENT_LIKE_IP_LIMIT,
  COMMENT_LIKE_USER_LIMIT,
  enforceRateLimit,
  FOLLOW_IP_LIMIT,
  FOLLOW_USER_LIMIT,
  POST_LIKE_IP_LIMIT,
  POST_LIKE_USER_LIMIT,
  REPORT_IP_LIMIT,
  REPORT_USER_LIMIT,
} from "../../index.ts";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { RateLimitedError } from "../../../../shared/base/errors.ts";

const hasRedis = !!Deno.env.get("REDIS_URL");
const skip = !hasRedis;

if (hasRedis) {
  resetRedisForTest();
  await connectRedis();
}

const ALL_LIMITS = [
  POST_LIKE_IP_LIMIT,
  POST_LIKE_USER_LIMIT,
  COMMENT_LIKE_IP_LIMIT,
  COMMENT_LIKE_USER_LIMIT,
  BOOKMARK_IP_LIMIT,
  BOOKMARK_USER_LIMIT,
  FOLLOW_IP_LIMIT,
  FOLLOW_USER_LIMIT,
  REPORT_IP_LIMIT,
  REPORT_USER_LIMIT,
] as const;

Deno.test({
  name: "hardening rate limit: 新增社区写操作限流配置合法",
  fn: () => {
    for (const cfg of ALL_LIMITS) {
      assertEquals(typeof cfg.windowSec, "number");
      assertEquals(typeof cfg.max, "number");
      assert(cfg.windowSec > 0);
      assert(cfg.max > 0);
    }
  },
});

Deno.test({
  name: "hardening rate limit: enforceRateLimit 超过阈值抛 RateLimitedError",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const previousRateLimitEnabled = Deno.env.get("RATE_LIMIT_ENABLED");
    const previousNojEnv = Deno.env.get("NOJ_ENV");
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    Deno.env.set("NOJ_ENV", "development");

    const redis = getRedis();
    // 使用一个短窗口小阈值，避免污染生产 key
    const key = `test-hardening:${Date.now()}`;
    await redis.del(`ratelimit:${key}`);
    const cfg = { windowSec: 60, max: 2 };

    try {
      await enforceRateLimit(key, cfg);
      await enforceRateLimit(key, cfg);
      try {
        await enforceRateLimit(key, cfg);
        throw new Error("expected RateLimitedError");
      } catch (err) {
        assertEquals(err instanceof RateLimitedError, true);
      }
    } finally {
      await redis.del(`ratelimit:${key}`);
      if (previousRateLimitEnabled === undefined) {
        Deno.env.delete("RATE_LIMIT_ENABLED");
      } else {
        Deno.env.set("RATE_LIMIT_ENABLED", previousRateLimitEnabled);
      }
      if (previousNojEnv === undefined) {
        Deno.env.delete("NOJ_ENV");
      } else {
        Deno.env.set("NOJ_ENV", previousNojEnv);
      }
    }
  },
});
