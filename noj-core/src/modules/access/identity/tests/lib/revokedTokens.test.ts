import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  isJtiRevoked,
  remainingTtlFromExp,
  revocationTtl,
  revokeJti,
} from "../../services/security/revokedTokens.ts";
import { ServiceUnavailableError } from "../../../../../shared/base/errors.ts";
import {
  closeRedisForShutdown,
  createRedisClientForUrl,
  getRedis,
  resetRedisForTest,
} from "../../../../../shared/mq/connection.ts";
import { startFakeRedisServer } from "../../../../../../tests/helpers/redis-resp.ts";

Deno.test({
  name: "revokedTokens: remainingTtlFromExp 计算剩余秒数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const now = Math.floor(Date.now() / 1000);

    // 未过期：返回 (exp - now)
    assertEquals(remainingTtlFromExp(now + 3600), 3600);

    // 已过期：返 0
    assertEquals(remainingTtlFromExp(now - 1), 0);

    // 未定义：返 0
    assertEquals(remainingTtlFromExp(undefined), 0);

    // 非数字：返 0
    assertEquals(
      remainingTtlFromExp("garbage" as unknown as number),
      0,
    );
  },
});

Deno.test({
  name: "revokedTokens: revocationTtl 覆盖长有效期 token，缺 exp 回退 24h",
  fn: () => {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDays = 30 * 24 * 3600;

    // 「记住我」token：TTL 等于剩余有效期，而非固定 24h
    const ttl = revocationTtl(now + thirtyDays);
    assertEquals(ttl >= thirtyDays - 1 && ttl <= thirtyDays, true);

    // 历史 token 无 exp：保守回退 24h
    assertEquals(revocationTtl(undefined), 24 * 3600);

    // 已过期：0（revokeJti 跳过写入）
    assertEquals(revocationTtl(now - 10), 0);
  },
});

Deno.test({
  name: "revokedTokens: revokeJti + isJtiRevoked 往返",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const redis = createRedisClientForUrl(
      Deno.env.get("REDIS_URL") ?? "redis://127.0.0.1:6379/",
    );
    await redis.connect();
    const jti = `test-jti-${Date.now()}-${crypto.randomUUID()}`;

    try {
      // 初始：未撤销
      assertEquals(await isJtiRevoked(jti, redis), false);

      // 撤销
      await revokeJti(jti, 60, redis);

      // 撤销后：命中
      assertEquals(await isJtiRevoked(jti, redis), true);

      // 清理（避免污染后续测试）
      await redis.del(`jwt:revoked:${jti}`);
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
  },
});

Deno.test({
  name: "revokedTokens: revokeJti 接受空 jti（no-op）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 空字符串不应抛错，也不应写入 Redis
    await revokeJti("", 60);
    await revokeJti("", 0);
  },
});

Deno.test({
  name: "revokedTokens: isJtiRevoked 空 jti 直接返 false",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assertEquals(await isJtiRevoked(""), false);
  },
});

Deno.test({
  name: "revokedTokens: TTL 过期后自动失效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const redis = createRedisClientForUrl(
      Deno.env.get("REDIS_URL") ?? "redis://127.0.0.1:6379/",
    );
    await redis.connect();
    const jti = `test-expire-${Date.now()}-${crypto.randomUUID()}`;

    try {
      // 设置 Redis 支持的最短 TTL（1 秒）
      await revokeJti(jti, 1, redis);
      assertEquals(await isJtiRevoked(jti, redis), true);

      // 条件等待：轮询直到 key 过期，避免固定 1.5s sleep
      const start = Date.now();
      while (await isJtiRevoked(jti, redis)) {
        if (Date.now() - start > 3000) {
          throw new Error("等待 Redis TTL 过期超时");
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(await isJtiRevoked(jti, redis), false);
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
  },
});

Deno.test({
  name: "revokedTokens: Redis 不可用时 isJtiRevoked 抛 503（fail-closed）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 使用专用错误客户端模拟 Redis 不可用，不修改进程级 REDIS_URL。
    const redis = createRedisClientForUrl("redis://127.0.0.1:1/");
    try {
      await assertRejects(
        async () => await isJtiRevoked("any-jti", redis),
        Error,
      );
    } finally {
      redis.disconnect();
    }
  },
});

Deno.test({
  name:
    "revokedTokens: 生产环境忽略 NOJ_BYPASS_JWT_REVOKE 并通过默认客户端 fail-closed（issue #655）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const prevEnv = Deno.env.get("NOJ_ENV");
    const prevBypass = Deno.env.get("NOJ_BYPASS_JWT_REVOKE");
    const prevUrl = Deno.env.get("REDIS_URL");

    // 关闭当前共享单例并清空引用：下面不传显式 client，必须走受保护的默认客户端分支。
    await closeRedisForShutdown().catch(() => {});
    resetRedisForTest();

    const server = await startFakeRedisServer({
      existsError: "ERR simulated revocation backend failure",
    });
    Deno.env.set("NOJ_ENV", "production");
    Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");
    Deno.env.set("REDIS_URL", server.url);
    const shared = getRedis();
    const jti = `prod-bypass-${crypto.randomUUID()}`;
    const started = performance.now();

    try {
      const error = await assertRejects(
        async () => await isJtiRevoked(jti),
        ServiceUnavailableError,
      );
      const elapsedMs = performance.now() - started;

      // 关键证据：默认客户端确实发出了 EXISTS，且没有走生产环境短路。
      assertEquals(server.existsKeys, [`jwt:revoked:${jti}`]);
      assert(
        error.message.includes("校验令牌撤销状态失败"),
        `错误信息应说明撤销状态校验失败：${error.message}`,
      );
      assert(
        elapsedMs < 5000,
        `撤销检查应立即失败（<5s），实际 ${Math.round(elapsedMs)}ms`,
      );
      console.log(
        `  → 生产环境撤销检查 fail-closed 耗时 ${Math.round(elapsedMs)}ms`,
      );
    } finally {
      // 先关闭指向测试服务的客户端（QUIT 由 fake server 响应），再恢复环境。
      // 给 quit 一个上限，避免测试服务异常时挂死；计时器必须清理。
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const closeBudget = new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, 2000);
      });
      try {
        await Promise.race([
          closeRedisForShutdown().catch(() => {}),
          closeBudget,
        ]);
      } finally {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      }
      try {
        shared.disconnect();
      } catch {
        // 已断开。
      }
      await server.close();

      restoreEnv("NOJ_ENV", prevEnv);
      restoreEnv("NOJ_BYPASS_JWT_REVOKE", prevBypass);
      restoreEnv("REDIS_URL", prevUrl);
      resetRedisForTest();
      await restoreRedisConnection();
    }
  },
});

Deno.test({
  name: "revokedTokens: 非生产环境允许 NOJ_BYPASS_JWT_REVOKE 短路",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const prevEnv = Deno.env.get("NOJ_ENV");
    const prevBypass = Deno.env.get("NOJ_BYPASS_JWT_REVOKE");
    const prevUrl = Deno.env.get("REDIS_URL");
    resetRedisForTest();
    Deno.env.set("NOJ_ENV", "test");
    Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");
    // 同样指向不存在的端口：能返回 false 说明短路生效，未触碰 Redis
    Deno.env.set("REDIS_URL", "redis://127.0.0.1:1/");

    try {
      assertEquals(await isJtiRevoked("test-bypass-jti"), false);
    } finally {
      restoreEnv("NOJ_ENV", prevEnv);
      restoreEnv("NOJ_BYPASS_JWT_REVOKE", prevBypass);
      restoreEnv("REDIS_URL", prevUrl);
      await restoreRedisConnection();
    }
  },
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value !== undefined) Deno.env.set(key, value);
  else Deno.env.delete(key);
}

/** 恢复 REDIS_URL 后重建共享连接，避免影响同 worker 后续用例。 */
async function restoreRedisConnection(): Promise<void> {
  resetRedisForTest();

  try {
    const { connectRedis } = await import(
      "../../../../../shared/mq/connection.ts"
    );
    await connectRedis();
  } catch {
    // ignore
  }
}
