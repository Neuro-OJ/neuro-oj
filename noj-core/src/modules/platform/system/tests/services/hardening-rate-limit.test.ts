/**
 * hardening 限流配置与基础行为测试。
 *
 * 不依赖 DB；限流基础行为依赖 Redis（无 Redis 时跳过）。
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  BOOKMARK_IP_LIMIT,
  BOOKMARK_USER_LIMIT,
  COMMENT_LIKE_IP_LIMIT,
  COMMENT_LIKE_USER_LIMIT,
  CONTEST_SUBMISSION_IP_LIMIT,
  CONTEST_SUBMISSION_USER_LIMIT,
  enforceRateLimit,
  FOLLOW_IP_LIMIT,
  FOLLOW_USER_LIMIT,
  OBJECTIVE_SUBMIT_IP_LIMIT,
  OBJECTIVE_SUBMIT_USER_LIMIT,
  POST_LIKE_IP_LIMIT,
  POST_LIKE_USER_LIMIT,
  REPORT_IP_LIMIT,
  REPORT_USER_LIMIT,
  SELF_TEST_IP_LIMIT,
  SELF_TEST_USER_LIMIT,
  SHARED_IP_SEATS,
  SUBMISSION_IP_LIMIT,
  SUBMISSION_USER_LIMIT,
} from "../../index.ts";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../../../../shared/mq/connection.ts";
import {
  RateLimitedError,
  ServiceUnavailableError,
} from "../../../../../shared/base/errors.ts";
import { enforceRateLimitWith } from "../../services/hardening-rate-limit.ts";

const hasRedis = !!Deno.env.get("REDIS_URL");

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

Deno.test({
  name:
    "hardening rate limit: 提交类 IP 阈值按机房席位放大，不再等于用户阈值（#698）",
  fn: () => {
    const pairs = [
      [SUBMISSION_IP_LIMIT, SUBMISSION_USER_LIMIT],
      [CONTEST_SUBMISSION_IP_LIMIT, CONTEST_SUBMISSION_USER_LIMIT],
      [OBJECTIVE_SUBMIT_IP_LIMIT, OBJECTIVE_SUBMIT_USER_LIMIT],
      [SELF_TEST_IP_LIMIT, SELF_TEST_USER_LIMIT],
    ] as const;
    for (const [ip, user] of pairs) {
      assertEquals(ip.windowSec, user.windowSec);
      assertEquals(ip.max, user.max * SHARED_IP_SEATS);
    }
    // 60 人机房同时交一次客观题不应触发 IP 维度
    assert(OBJECTIVE_SUBMIT_IP_LIMIT.max >= 60 * 1);
    assert(SELF_TEST_IP_LIMIT.max >= 60 * SELF_TEST_USER_LIMIT.max);
  },
});

const unavailableCheck = () =>
  Promise.reject(new ServiceUnavailableError("限流服务暂时不可用"));

Deno.test({
  name: "hardening rate limit: Redis 不可用时默认 reject 抛 503",
  fn: async () => {
    await assertRejects(
      () =>
        enforceRateLimitWith(
          unavailableCheck,
          "test:reject",
          { windowSec: 60, max: 1 },
          "x",
          "reject",
        ),
      ServiceUnavailableError,
    );
  },
});

Deno.test({
  name: "hardening rate limit: Redis 不可用时 allow 策略放行",
  fn: async () => {
    await enforceRateLimitWith(
      unavailableCheck,
      "test:allow",
      { windowSec: 60, max: 1 },
      "x",
      "allow",
    );
  },
});

Deno.test({
  name: "hardening rate limit: allow 策略不吞掉非 Redis 故障错误",
  fn: async () => {
    await assertRejects(
      () =>
        enforceRateLimitWith(
          () => Promise.reject(new TypeError("bug")),
          "test:allow-bug",
          { windowSec: 60, max: 1 },
          "x",
          "allow",
        ),
      TypeError,
    );
  },
});

Deno.test({
  name: "hardening rate limit: allow 策略下超限仍抛 429",
  fn: async () => {
    await assertRejects(
      () =>
        enforceRateLimitWith(
          () =>
            Promise.resolve({
              allowed: false,
              remaining: 0,
              resetAt: 0,
              retryAfter: 1,
            }),
          "test:allow-limited",
          { windowSec: 60, max: 1 },
          "x",
          "allow",
        ),
      RateLimitedError,
    );
  },
});
