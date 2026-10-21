import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  isJtiRevoked,
  remainingTtlFromExp,
  revocationTtl,
  revokeJti,
} from "../../services/security/revokedTokens.ts";
import {
  createRedisClientForUrl,
} from "../../../../../shared/mq/connection.ts";

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
