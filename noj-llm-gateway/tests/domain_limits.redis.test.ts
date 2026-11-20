import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import IORedis from "ioredis";
import type { Db } from "../src/db.ts";
import type { EvalTokenPayload } from "../src/crypto.ts";
import { enforceAndCount, settleUsage } from "../src/limits.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  gatewayTestRedisUrl as redisUrl,
  runRedisPrefix,
} from "./integration-env.ts";

Deno.test({
  name:
    "域额度 Redis：最后一次额度并发只受理一次、跨域独立、实际结算与实例总额",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // 每轮测试所有 Lua 键加独立前缀，不读取、删除或累计开发服务的真实额度。
    // @ts-ignore - ioredis 构造函数在 Deno 中的类型解析限制
    const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: 1 });
    const prefix = runRedisPrefix("domain-limits");
    const keys = new Set<string>();
    const redis = {
      eval(script: string, rawKeys: string[], args: (string | number)[]) {
        const scoped = rawKeys.map((key) => prefix + key);
        for (const key of scoped) keys.add(key);
        return connection.eval(script, scoped.length, ...scoped, ...args);
      },
    } as RedisClient;
    let instanceCalls: number | null = null;
    const db = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      // 实例政策现在只从 Gateway 本地 llm_policy 读取；无政策行 = 空上限。
      if (strings.join("").includes("llm_policy")) {
        return Promise.resolve([]);
      }
      const [, scope, , window] = values;
      return Promise.resolve([{
        max_calls: scope === "global" && window === "day"
          ? instanceCalls
          : scope === "domain" && window === "day"
          ? 1
          : null,
        max_tokens: null,
        max_cost: null,
      }]);
    }) as unknown as Db;
    const payload: EvalTokenPayload = {
      domain_id: "school-a",
      attempt_id: "attempt-a",
      protocol_version: 3,
      jti: "test",
      submission_id: "same-submission",
      problem_id: "shared-source",
      user_id: "same-student",
      provider_id: "provider",
      allowed_models: ["model"],
      iat: 0,
      exp: Number.MAX_SAFE_INTEGER,
      max_calls: 10,
      max_tokens: 1000,
    };
    const reserve = {
      model: "model",
      promptTokens: 2,
      completionTokens: 8,
      estimatedCost: 5,
      ip: "unknown",
      ttlSeconds: 60,
      userRateLimitPerMinute: 100,
      ipRateLimitPerMinute: 100,
    };
    try {
      const results = await Promise.allSettled([
        enforceAndCount(db, redis, payload, reserve),
        enforceAndCount(
          db,
          redis,
          { ...payload, attempt_id: "attempt-a-2" },
          reserve,
        ),
      ]);
      assertEquals(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assertEquals(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      const winner = results[0].status === "fulfilled"
        ? payload
        : { ...payload, attempt_id: "attempt-a-2" };
      await settleUsage(db, redis, winner, {
        ...reserve,
        actualPromptTokens: 1,
        actualCompletionTokens: 2,
        actualBilledTotalTokens: 3,
        actualCost: 2,
      });
      const day = new Date().toISOString().slice(0, 10);
      assertEquals(
        await connection.get(
          prefix + "llm:domain:school-a:domain::day:" + day + ":calls",
        ),
        "1",
      );
      assertEquals(
        await connection.get(
          prefix + "llm:domain:school-a:domain::day:" + day + ":tokens",
        ),
        "3",
      );
      assertEquals(
        await connection.get(
          prefix + "llm:domain:school-a:domain::day:" + day + ":cost",
        ),
        "2",
      );
      const schoolB = {
        ...payload,
        domain_id: "school-b",
        attempt_id: "attempt-b",
      };
      await enforceAndCount(db, redis, schoolB, reserve);
      assertEquals(
        await connection.get(
          prefix + "llm:domain:school-b:domain::day:" + day + ":calls",
        ),
        "1",
      );
      assertEquals(
        await connection.get(prefix + "llm:global:day:" + day + ":calls"),
        "2",
      );
      instanceCalls = 2;
      await assertRejects(
        () =>
          enforceAndCount(db, redis, {
            ...payload,
            domain_id: "school-c",
            attempt_id: "attempt-c",
          }, reserve),
        Error,
        "limit_exceeded",
      );
      assertEquals(
        await connection.get(
          prefix + "llm:domain:school-c:attempt:attempt-c:calls",
        ),
        null,
      );
      assertEquals(
        await connection.get(prefix + "llm:global:day:" + day + ":calls"),
        "2",
      );
    } finally {
      if (keys.size) await connection.del(...keys);
      await connection.quit();
    }
  },
});
