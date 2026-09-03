import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  isJtiRevoked,
  remainingTtlFromExp,
  revokeJti,
} from "./../../src/domains/identity/services/security/revokedTokens.ts";
import {
  getRedis,
  resetRedisForTest,
} from "./../../src/shared/mq/connection.ts";

const hasRedis = !!Deno.env.get("REDIS_URL");

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
  name: "revokedTokens: revokeJti + isJtiRevoked 往返",
  ignore: !hasRedis,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRedisForTest();
    const { connectRedis } = await import(
      "./../../src/shared/mq/connection.ts"
    );
    try {
      await connectRedis();
    } catch (e) {
      if (!String(e).includes("already connecting/connected")) throw e;
    }

    const jti = `test-jti-${Date.now()}-${crypto.randomUUID()}`;

    // 初始：未撤销
    assertEquals(await isJtiRevoked(jti), false);

    // 撤销
    await revokeJti(jti, 60);

    // 撤销后：命中
    assertEquals(await isJtiRevoked(jti), true);

    // 清理（避免污染后续测试）
    try {
      const redis = getRedis();
      await redis.del(`jwt:revoked:${jti}`);
    } catch {
      // ignore
    }
  },
});

Deno.test({
  name: "revokedTokens: revokeJti 接受空 jti（no-op）",
  ignore: !hasRedis,
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
  ignore: !hasRedis,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assertEquals(await isJtiRevoked(""), false);
  },
});

Deno.test({
  name: "revokedTokens: TTL 过期后自动失效",
  ignore: !hasRedis,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRedisForTest();
    const { connectRedis } = await import(
      "./../../src/shared/mq/connection.ts"
    );
    try {
      await connectRedis();
    } catch (e) {
      if (!String(e).includes("already connecting/connected")) throw e;
    }

    const jti = `test-expire-${Date.now()}-${crypto.randomUUID()}`;

    // 设置 Redis 支持的最短 TTL（1 秒）
    await revokeJti(jti, 1);
    assertEquals(await isJtiRevoked(jti), true);

    // 条件等待：轮询直到 key 过期，避免固定 1.5s sleep
    const start = Date.now();
    while (await isJtiRevoked(jti)) {
      if (Date.now() - start > 3000) {
        throw new Error("等待 Redis TTL 过期超时");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(await isJtiRevoked(jti), false);
  },
});

Deno.test({
  name: "revokedTokens: Redis 不可用时 isJtiRevoked 抛 503（fail-closed）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 重置连接模拟 Redis 不可用
    resetRedisForTest();

    // 设置错误的 REDIS_URL 让 getRedis() 抛错
    const prevUrl = Deno.env.get("REDIS_URL");
    Deno.env.set("REDIS_URL", "redis://127.0.0.1:1/"); // 端口 1 不存在
    // 并行模式下其他 worker 可能设置了 NOJ_BYPASS_JWT_REVOKE=1，这里临时清除
    const prevBypass = Deno.env.get("NOJ_BYPASS_JWT_REVOKE");
    Deno.env.delete("NOJ_BYPASS_JWT_REVOKE");

    try {
      await assertRejects(
        async () => await isJtiRevoked("any-jti"),
        Error,
      );
    } finally {
      if (prevBypass !== undefined) {
        Deno.env.set("NOJ_BYPASS_JWT_REVOKE", prevBypass);
      } else {
        Deno.env.delete("NOJ_BYPASS_JWT_REVOKE");
      }
      if (prevUrl !== undefined) {
        Deno.env.set("REDIS_URL", prevUrl);
      } else {
        Deno.env.delete("REDIS_URL");
      }
      resetRedisForTest();
      // 恢复可用连接
      if (hasRedis) {
        try {
          const { connectRedis } = await import(
            "./../../src/shared/mq/connection.ts"
          );
          await connectRedis();
        } catch {
          // ignore
        }
      }
    }
  },
});
