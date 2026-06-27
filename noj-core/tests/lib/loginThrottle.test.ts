/**
 * 登录限流（issue #73）单元测试。
 *
 * 覆盖：
 * - checkRateLimit INCR 计数 + 阈值拒绝
 * - recordLoginFailure 累加 + 阈值后锁定
 * - applyLoginBackoff 内存退避
 * - clearLoginFailure 成功清零
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { checkRateLimit } from "../../src/lib/rateLimit.ts";
import {
  _clearLoginBackoffForTest,
  applyLoginBackoff,
  clearLoginFailure,
  isLoginLocked,
  recordLoginFailure,
} from "../../src/lib/loginThrottle.ts";
import { connectRedis, resetRedisForTest } from "../../src/mq/connection.ts";

const hasRedis = !!Deno.env.get("REDIS_URL");
const skip = !hasRedis;

/** 确保 Redis 已连接（幂等：已连接则跳过） */
async function ensureConnected() {
  resetRedisForTest();
  try {
    await connectRedis();
  } catch (e) {
    if (!String(e).includes("already connecting/connected")) throw e;
  }
}

Deno.test({
  name: "rateLimit: 窗口内超限后 429",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureConnected();
    const key = `test:basic:${Date.now()}:${Math.random()}`;
    // 10 次都允许
    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimit(key, { windowSec: 30, max: 10 });
      assertEquals(r.allowed, true, `第 ${i + 1} 次应允许`);
    }
    // 第 11 次拒绝
    const r = await checkRateLimit(key, { windowSec: 30, max: 10 });
    assertEquals(r.allowed, false);
    assertEquals(r.retryAfter > 0, true);
    assertEquals(r.remaining, 0);
  },
});

Deno.test({
  name: "rateLimit: 独立 key 互不影响",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureConnected();
    const a = `test:iso:a:${Date.now()}:${Math.random()}`;
    const b = `test:iso:b:${Date.now()}:${Math.random()}`;
    // a 跑满
    for (let i = 0; i < 10; i++) {
      await checkRateLimit(a, { windowSec: 30, max: 10 });
    }
    const aR = await checkRateLimit(a, { windowSec: 30, max: 10 });
    assertEquals(aR.allowed, false);
    // b 不受影响
    const bR = await checkRateLimit(b, { windowSec: 30, max: 10 });
    assertEquals(bR.allowed, true);
  },
});

Deno.test({
  name: "loginThrottle: 失败累加，10 次后锁定",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureConnected();
    const username = `locktest_${Date.now()}_${Math.random()}`;
    // 前 9 次：未锁定
    for (let i = 1; i <= 9; i++) {
      await recordLoginFailure(username);
      assertEquals(
        await isLoginLocked(username),
        false,
        `第 ${i} 次失败不应锁定`,
      );
    }
    // 第 10 次：触发锁定
    await recordLoginFailure(username);
    assertEquals(await isLoginLocked(username), true);

    // 清理
    await clearLoginFailure(username);
    assertEquals(await isLoginLocked(username), false);
  },
});

Deno.test({
  name: "loginThrottle: clearLoginFailure 清零失败计数",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await ensureConnected();
    const username = `cleartest_${Date.now()}_${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(username);
    }
    await clearLoginFailure(username);
    // 清零后不会触发锁定（需要 10 次）
    for (let i = 0; i < 8; i++) {
      await recordLoginFailure(username);
    }
    assertEquals(await isLoginLocked(username), false);
    await clearLoginFailure(username);
  },
});

Deno.test({
  name: "loginThrottle: applyLoginBackoff 无 deadline 立即返回",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _clearLoginBackoffForTest();
    const t0 = Date.now();
    await applyLoginBackoff(`nodata_${Date.now()}_${Math.random()}`);
    const elapsed = Date.now() - t0;
    assert(elapsed < 50, `期望立即返回，实际 ${elapsed}ms`);
  },
});

Deno.test({
  name: "rateLimit: 响应头格式正确",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { rateLimitHeaders } = await import("../../src/lib/rateLimit.ts");
    const headers = rateLimitHeaders(
      { windowSec: 30, max: 10 },
      { allowed: false, remaining: 0, resetAt: 1700000000, retryAfter: 25 },
    );
    assertEquals(headers["X-RateLimit-Limit"], "10");
    assertEquals(headers["X-RateLimit-Remaining"], "0");
    assertEquals(headers["X-RateLimit-Reset"], "1700000000");
    assertEquals(headers["Retry-After"], "25");
  },
});
