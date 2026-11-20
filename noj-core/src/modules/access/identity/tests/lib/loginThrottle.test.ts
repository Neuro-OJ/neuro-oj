/**
 * 登录限流（issue #73）单元测试。
 *
 * 覆盖：
 * - checkRateLimit INCR 计数 + 阈值拒绝
 * - recordLoginFailure 累加 + 阈值后锁定
 * - applyLoginBackoff 内存退避
 * - clearLoginFailure 成功清零
 */

import { FakeTime } from "jsr:@std/testing@1/time";
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { checkRateLimit } from "../../../../../shared/rate-limit/rate-limit.ts";
import {
  _resetLoginBackoffForTest,
  applyLoginBackoff,
  clearAllLoginFailures,
  clearLoginFailure,
  isLoginLocked,
  recordLoginBackoff,
  recordLoginFailure,
} from "../../services/security/loginThrottle.ts";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../../../../shared/mq/connection.ts";

/** 确保 Redis 已连接（幂等：已连接则跳过） */
async function ensureConnected() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resetRedisForTest();
      await connectRedis();
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      if (String(e).includes("already connecting/connected")) return;
      // 重试前等待一小段时间（避免 parallel 模式下的连接竞争）
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/**
 * 只在当前用例开启限流。
 *
 * 不要临时删除/修改 NOJ_ENV：并行 runner 中它是整个测试进程共享的环境变量，
 * 另一个测试恢复该变量会让本用例在第 10 次检查时突然退回“限流关闭”语义。
 * `isRateLimitEnabled()` 在 NOJ_ENV=test 时允许 RATE_LIMIT_ENABLED 显式覆盖，
 * 因此只改这个专用开关即可。
 */
async function withRateLimitEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const orig = Deno.env.get("RATE_LIMIT_ENABLED");
  Deno.env.set("RATE_LIMIT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    if (orig !== undefined) Deno.env.set("RATE_LIMIT_ENABLED", orig);
    else Deno.env.delete("RATE_LIMIT_ENABLED");
  }
}

Deno.test({
  name: "rateLimit: 窗口内超限后 429",
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
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      await ensureConnected();
      const username = `locktest_${Date.now()}_${Math.random()}`;
      // 前 9 次：未锁定
      for (let i = 1; i <= 9; i++) {
        await recordLoginFailure(username, "192.0.2.1");
        assertEquals(
          await isLoginLocked(username, "192.0.2.1"),
          false,
          `第 ${i} 次失败不应锁定`,
        );
      }
      // 第 10 次：触发锁定
      await recordLoginFailure(username, "192.0.2.1");
      assertEquals(await isLoginLocked(username, "192.0.2.1"), true);

      // 清理
      await clearLoginFailure(username, "192.0.2.1");
      assertEquals(await isLoginLocked(username, "192.0.2.1"), false);
    });
  },
});

Deno.test({
  name: "loginThrottle: clearLoginFailure 清零失败计数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      await ensureConnected();
      const username = `cleartest_${Date.now()}_${Math.random()}`;
      for (let i = 0; i < 5; i++) {
        await recordLoginFailure(username, "192.0.2.1");
      }
      await clearLoginFailure(username, "192.0.2.1");
      // 清零后不会触发锁定（需要 10 次）
      for (let i = 0; i < 8; i++) {
        await recordLoginFailure(username, "192.0.2.1");
      }
      assertEquals(await isLoginLocked(username, "192.0.2.1"), false);
      await clearLoginFailure(username, "192.0.2.1");
    });
  },
});

Deno.test({
  name: "loginThrottle: applyLoginBackoff 无 deadline 立即返回",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetLoginBackoffForTest();
    const t0 = Date.now();
    await applyLoginBackoff(
      `nodata_${Date.now()}_${Math.random()}`,
      "192.0.2.1",
    );
    const elapsed = Date.now() - t0;
    assert(elapsed < 50, `期望立即返回，实际 ${elapsed}ms`);
  },
});

Deno.test({
  name: "rateLimit: 响应头格式正确",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { rateLimitHeaders } = await import(
      "../../../../../shared/rate-limit/rate-limit.ts"
    );
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

Deno.test({
  name: "loginThrottle: 各命名空间按小写账号 + IP 隔离，成功仅清理本 IP",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      await ensureConnected();
      const username = `ip_scope_${crypto.randomUUID()}`;
      const ipA = "192.0.2.10";
      const ipB = "2001:db8::20";
      try {
        for (const ns of ["login", "pwchange", "tfa"]) {
          for (let i = 0; i < 10; i++) {
            await recordLoginFailure(username.toUpperCase(), ipA, ns);
          }
          assertEquals(await isLoginLocked(username, ipA, ns), true);
          assertEquals(await isLoginLocked(username, ipB, ns), false);
          assertEquals(await recordLoginFailure(username, ipB, ns), 1);
          await clearLoginFailure(username, ipB, ns);
          assertEquals(await recordLoginFailure(username, ipB, ns), 1);
          assertEquals(await isLoginLocked(username, ipA, ns), true);
        }
        await clearLoginFailure(username, ipA, "pwchange");
        assertEquals(await isLoginLocked(username, ipA, "pwchange"), false);
        assertEquals(await isLoginLocked(username, ipA, "login"), true);
        assertEquals(await isLoginLocked(username, ipA, "tfa"), true);
      } finally {
        await clearAllLoginFailures(username);
      }
    });
  },
});

Deno.test({
  name: "loginThrottle: 退避按 IP 与命名空间隔离，管理员清理全部退避",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      await ensureConnected();
      const username = `backoff_scope_${crypto.randomUUID()}`;
      using time = new FakeTime();
      try {
        recordLoginBackoff(username.toUpperCase(), "192.0.2.1", 1);
        await applyLoginBackoff(username, "192.0.2.2");
        await applyLoginBackoff(username, "192.0.2.1", "pwchange");
        let finished = false;
        const waiting = applyLoginBackoff(username, "192.0.2.1").then(() => {
          finished = true;
        });
        await Promise.resolve();
        assertEquals(finished, false);
        time.tick(15_000);
        await waiting;
        assertEquals(finished, true);

        for (const ns of ["login", "pwchange", "tfa", "custom-ns"]) {
          for (const ip of ["192.0.2.1", "2001:db8::2"]) {
            recordLoginBackoff(username, ip, 1, ns);
          }
        }
        await clearAllLoginFailures(username.toUpperCase());
        for (const ns of ["login", "pwchange", "tfa", "custom-ns"]) {
          await applyLoginBackoff(username, "192.0.2.1", ns);
          await applyLoginBackoff(username, "2001:db8::2", ns);
        }
        // 成功清理退避也只作用于当前 IP。
        recordLoginBackoff(username, "192.0.2.1", 1);
        recordLoginBackoff(username, "192.0.2.2", 1);
        await clearLoginFailure(username, "192.0.2.1");
        await applyLoginBackoff(username, "192.0.2.1");
        finished = false;
        const otherIp = applyLoginBackoff(username, "192.0.2.2").then(() => {
          finished = true;
        });
        await Promise.resolve();
        assertEquals(finished, false);
        time.tick(15_000);
        await otherIp;
      } finally {
        _resetLoginBackoffForTest();
      }
    });
  },
});

Deno.test({
  name: "loginThrottle: 管理员扫描分页清理全部命名空间且不扩散到其他账号或窗口",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRateLimitEnabled(async () => {
      await ensureConnected();
      const redis = getRedis();
      const username = `scan_*?[x]:${crypto.randomUUID()}`;
      const other = `${username}_other`;
      const windowKey = `ratelimit:login:acc:${username}`;
      try {
        // 超过 SCAN COUNT 提示值，覆盖多页扫描。
        for (let i = 0; i < 120; i++) {
          await recordLoginFailure(username, `192.0.2.${i}`, "custom-ns");
        }
        for (const ns of ["login", "pwchange", "tfa"]) {
          for (const ip of ["192.0.2.1", "2001:db8::2"]) {
            for (let i = 0; i < 10; i++) {
              await recordLoginFailure(username, ip, ns);
            }
          }
        }
        await recordLoginFailure(other, "192.0.2.1");
        await redis.set(windowKey, "5", "EX", 30);
        // 即使临时关闭限流，管理员仍需清理已有键。
        Deno.env.set("RATE_LIMIT_ENABLED", "false");
        await clearAllLoginFailures(username.toUpperCase());
        Deno.env.set("RATE_LIMIT_ENABLED", "true");
        for (let i = 0; i < 120; i++) {
          assertEquals(
            await recordLoginFailure(username, `192.0.2.${i}`, "custom-ns"),
            1,
          );
        }
        for (const ns of ["login", "pwchange", "tfa"]) {
          for (const ip of ["192.0.2.1", "2001:db8::2"]) {
            assertEquals(await isLoginLocked(username, ip, ns), false);
            assertEquals(await recordLoginFailure(username, ip, ns), 1);
          }
        }
        assertEquals(await recordLoginFailure(other, "192.0.2.1"), 2);
        assertEquals(await redis.get(windowKey), "5");
      } finally {
        Deno.env.set("RATE_LIMIT_ENABLED", "true");
        await clearAllLoginFailures(username);
        await clearAllLoginFailures(other);
        await redis.del(windowKey);
      }
    });
  },
});
