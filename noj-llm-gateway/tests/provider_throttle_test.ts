// Provider RPM / TPM 节流与排队测试。
//
// 前半部分用桩 eval 验证 TS 侧轮询 / 超时 / 中止逻辑；后半部分由正式
// test-launcher 提供真实隔离 Redis（Lua 脚本无法在 FakeRedis 中执行）。
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  acquireProviderSlot,
  ProviderQueueAbortedError,
  ProviderQueueTimeoutError,
  providerThrottleKeys,
} from "../src/provider-throttle.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { FakeRedis } from "./helpers.ts";
import {
  gatewayTestRedisPrefix,
  gatewayTestRedisUrl as REDIS_URL,
} from "./integration-env.ts";

Deno.test("provider throttle: RPM/TPM 均为 0 时直接放行且不访问 Redis", async () => {
  const redis = new FakeRedis();
  const slot = await acquireProviderSlot(redis, {
    providerId: "p",
    rpmLimit: 0,
    tpmLimit: 0,
    tokens: 100,
    timeoutMs: 0,
  });
  assertEquals(slot.waitedMs, 0);
  await slot.settle(5);
  await slot.release();
  assertEquals(redis.evalKeys.length, 0);
});

Deno.test("provider throttle: 排队超时抛出 ProviderQueueTimeoutError 并退出队列", async () => {
  const redis = new FakeRedis();
  redis.evalResults = [[0, 1500, 0], [0, 1500, 0], [0, 1500, 0], 1];
  const err = await assertRejects(
    () =>
      acquireProviderSlot(redis, {
        providerId: "p",
        rpmLimit: 1,
        tpmLimit: 0,
        tokens: 1,
        timeoutMs: 30,
      }),
    ProviderQueueTimeoutError,
  );
  assertEquals(err.retryAfterSeconds, 2);
  const keys = providerThrottleKeys("p");
  assertEquals(redis.evalKeys.at(-1), [keys.queue, keys.hb]);
});

Deno.test("provider throttle: 客户端断开时中止排队并退出队列", async () => {
  const redis = new FakeRedis();
  redis.evalResults = [[0, 0, 3], 1];
  const controller = new AbortController();
  const pending = acquireProviderSlot(redis, {
    providerId: "p",
    rpmLimit: 1,
    tpmLimit: 0,
    tokens: 1,
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  controller.abort();
  await assertRejects(() => pending, ProviderQueueAbortedError);
  const keys = providerThrottleKeys("p");
  assertEquals(redis.evalKeys.at(-1), [keys.queue, keys.hb]);
});

// ─── 真实 Redis：验证 Lua 脚本语义 ──────────────────────────────

/** 每个用例使用独立 Provider ID，结束后清理其全部键。 */
async function withRedis(
  fn: (redis: RedisClient, providerId: string) => Promise<void>,
): Promise<void> {
  const redis = createRedis(REDIS_URL);
  const providerId = `${gatewayTestRedisPrefix}provider-${crypto.randomUUID()}`;
  // 预热连接：避免首个用例把建连耗时计入 waitedMs
  await redis.ping();
  try {
    await fn(redis, providerId);
  } finally {
    const keys = Object.values(providerThrottleKeys(providerId));
    await redis.eval(
      "for _, k in ipairs(KEYS) do redis.call('DEL', k) end return 1",
      keys,
      [],
    );
    await redis.quit?.();
  }
}

const realRedisTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });

realRedisTest(
  "provider throttle(redis): RPM 超限后排队，窗口滑出即放行",
  async () => {
    await withRedis(async (redis, providerId) => {
      const opts = {
        providerId,
        rpmLimit: 2,
        tpmLimit: 0,
        tokens: 1,
        timeoutMs: 5_000,
        windowMs: 1_000,
      };
      const startedAt = Date.now();
      const a = await acquireProviderSlot(redis, opts);
      const b = await acquireProviderSlot(redis, opts);
      assertEquals(a.waitedMs < 500, true);
      assertEquals(b.waitedMs < 500, true);
      const c = await acquireProviderSlot(redis, opts);
      // 第三个请求须等到第一个请求（放行于 startedAt 之后）滑出窗口才能放行；
      // 留 50ms 容差覆盖 Redis TIME 与本机时钟的细微偏差
      const elapsed = Date.now() - startedAt;
      assert(c.waitedMs > 0, "第三个请求应发生排队");
      assert(elapsed >= 950, `应在首个请求滑出窗口后放行，实际 ${elapsed}ms`);
    });
  },
);

realRedisTest("provider throttle(redis): 排队超时后队列被清理", async () => {
  await withRedis(async (redis, providerId) => {
    const opts = {
      providerId,
      rpmLimit: 1,
      tpmLimit: 0,
      tokens: 1,
      timeoutMs: 100,
      windowMs: 10_000,
    };
    await acquireProviderSlot(redis, opts);
    await assertRejects(
      () => acquireProviderSlot(redis, opts),
      ProviderQueueTimeoutError,
    );
    const keys = providerThrottleKeys(providerId);
    const queued = await redis.eval(
      "return redis.call('ZCARD', KEYS[1])",
      [keys.queue],
      [],
    );
    assertEquals(queued, 0);
  });
});

realRedisTest(
  "provider throttle(redis): TPM 按预估占用，settle 修正后释放余量",
  async () => {
    await withRedis(async (redis, providerId) => {
      const base = {
        providerId,
        rpmLimit: 0,
        tpmLimit: 100,
        windowMs: 10_000,
      };
      const first = await acquireProviderSlot(redis, {
        ...base,
        tokens: 80,
        timeoutMs: 0,
      });
      // 80 + 50 > 100：不排队时立即超时
      await assertRejects(
        () => acquireProviderSlot(redis, { ...base, tokens: 50, timeoutMs: 0 }),
        ProviderQueueTimeoutError,
      );
      // 实际只用了 10 token：修正后 10 + 50 <= 100，立即放行
      await first.settle(10);
      const second = await acquireProviderSlot(redis, {
        ...base,
        tokens: 50,
        timeoutMs: 0,
      });
      assertEquals(second.waitedMs < 2_000, true);
    });
  },
);

realRedisTest(
  "provider throttle(redis): 单个请求超过 TPM 时在空窗口放行，不会永久阻塞",
  async () => {
    await withRedis(async (redis, providerId) => {
      const slot = await acquireProviderSlot(redis, {
        providerId,
        rpmLimit: 0,
        tpmLimit: 100,
        tokens: 500,
        timeoutMs: 0,
        windowMs: 10_000,
      });
      assertEquals(slot.waitedMs < 2_000, true);
    });
  },
);

realRedisTest("provider throttle(redis): release 归还额度", async () => {
  await withRedis(async (redis, providerId) => {
    const opts = {
      providerId,
      rpmLimit: 1,
      tpmLimit: 0,
      tokens: 1,
      timeoutMs: 0,
      windowMs: 10_000,
    };
    const slot = await acquireProviderSlot(redis, opts);
    await slot.release();
    const again = await acquireProviderSlot(redis, opts);
    assertEquals(again.waitedMs < 2_000, true);
  });
});

realRedisTest(
  "provider throttle(redis): 先到先得，后来的小请求不插队",
  async () => {
    await withRedis(async (redis, providerId) => {
      const base = {
        providerId,
        rpmLimit: 0,
        tpmLimit: 100,
        timeoutMs: 5_000,
        windowMs: 500,
      };
      await acquireProviderSlot(redis, { ...base, tokens: 90 });
      const order: string[] = [];
      // big 先入队（需等窗口滑出），small 后入队（单看余量本可立即放行）
      const big = acquireProviderSlot(redis, { ...base, tokens: 60 }).then(() =>
        order.push("big")
      );
      await new Promise((r) => setTimeout(r, 50));
      const small = acquireProviderSlot(redis, { ...base, tokens: 5 }).then(
        () => order.push("small"),
      );
      await Promise.all([big, small]);
      assertEquals(order, ["big", "small"]);
    });
  },
);

realRedisTest(
  "provider throttle(redis): 失联的队首被心跳超时清理",
  async () => {
    await withRedis(async (redis, providerId) => {
      const keys = providerThrottleKeys(providerId);
      // 模拟崩溃副本遗留的队首：票号 0、心跳为 0（远早于超时阈值）
      await redis.eval(
        "redis.call('ZADD', KEYS[1], 0, 'ghost') redis.call('HSET', KEYS[2], 'ghost', 0) return 1",
        [keys.queue, keys.hb],
        [],
      );
      const slot = await acquireProviderSlot(redis, {
        providerId,
        rpmLimit: 5,
        tpmLimit: 0,
        tokens: 1,
        timeoutMs: 0,
        windowMs: 10_000,
      });
      assertEquals(slot.waitedMs < 2_000, true);
    });
  },
);
