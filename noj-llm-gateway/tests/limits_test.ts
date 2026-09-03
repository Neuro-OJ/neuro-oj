import { assertEquals } from "jsr:@std/assert@^1";
import type { Db } from "../src/db.ts";
import type { EvalTokenPayload } from "../src/crypto.ts";
import { enforceAndCount, settleUsage } from "../src/limits.ts";
import type { RedisClient } from "../src/redis.ts";
import { incrByWithTtl, incrWithTtl } from "../src/redis.ts";

class FakeRedis implements RedisClient {
  data = new Map<string, number>();
  expires = new Map<string, number>();
  lastEvalArgs: (string | number)[] = [];

  async incr(key: string): Promise<number> {
    const next = (this.data.get(key) ?? 0) + 1;
    this.data.set(key, next);
    return await Promise.resolve(next);
  }

  async incrby(key: string, amount: number): Promise<number> {
    const next = (this.data.get(key) ?? 0) + amount;
    this.data.set(key, next);
    return await Promise.resolve(next);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expires.set(key, seconds);
    return await Promise.resolve(1);
  }

  async get(key: string): Promise<string | null> {
    const value = this.data.get(key);
    return await Promise.resolve(
      value === undefined ? null : String(value),
    );
  }

  async set(key: string, value: string): Promise<unknown> {
    this.data.set(key, Number(value));
    return await Promise.resolve("OK");
  }

  async sadd(_key: string, _member: string): Promise<number> {
    return await Promise.resolve(0);
  }

  async scard(_key: string): Promise<number> {
    return await Promise.resolve(0);
  }

  async eval(
    _script: string,
    _keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    this.lastEvalArgs = args;
    return await Promise.resolve("ok");
  }
}

const emptyDb = ((
  _strings: TemplateStringsArray,
  ..._values: unknown[]
) => Promise.resolve([])) as unknown as Db;

const payload: EvalTokenPayload = {
  jti: "jti-1",
  submission_id: "submission-1",
  problem_id: "problem-1",
  user_id: "user-1",
  provider_id: "provider-1",
  allowed_models: ["model-1"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 60,
  max_calls: 10,
  max_tokens: 1000,
};

Deno.test("limits: incrWithTtl sets TTL on first increment", async () => {
  const redis = new FakeRedis();
  const first = await incrWithTtl(redis, "llm:test:count", 60);
  const second = await incrWithTtl(redis, "llm:test:count", 60);
  assertEquals(first, 1);
  assertEquals(second, 2);
  assertEquals(redis.expires.get("llm:test:count"), 60);
});

Deno.test("limits: incrByWithTtl increments and sets TTL", async () => {
  const redis = new FakeRedis();
  const value = await incrByWithTtl(redis, "llm:test:tokens", 25, 120);
  assertEquals(value, 25);
  assertEquals(redis.expires.get("llm:test:tokens"), 120);
});

Deno.test("limits: enforceAndCount passes independent minute limits", async () => {
  const redis = new FakeRedis();
  await enforceAndCount(emptyDb, redis, payload, {
    model: "model-1",
    promptTokens: 10,
    completionTokens: 5,
    estimatedCost: 1,
    ip: "127.0.0.1",
    ttlSeconds: 60,
    userRateLimitPerMinute: 120,
    ipRateLimitPerMinute: 30,
  });

  assertEquals(redis.lastEvalArgs[0], 120);
  assertEquals(redis.lastEvalArgs[1], 30);
  assertEquals(redis.lastEvalArgs[2], 60);
  const meta = JSON.parse(String(redis.lastEvalArgs[3])) as {
    limits: number[];
    incs: number[];
    ttls: number[];
  };
  assertEquals(meta.limits[0], payload.max_calls);
  assertEquals(meta.incs[0], 1);
});

Deno.test("limits: settleUsage 按 billedTotal 计算 delta", async () => {
  const redis = new FakeRedis();
  // 先 enforce 预占：估算 prompt=100, completion=50 => 预占 150
  await enforceAndCount(emptyDb, redis, { ...payload, max_tokens: 1000 }, {
    model: "model-1",
    promptTokens: 100,
    completionTokens: 50,
    estimatedCost: 1,
    ip: "127.0.0.1",
    ttlSeconds: 60,
    userRateLimitPerMinute: 120,
    ipRateLimitPerMinute: 30,
  });

  // 实际上游 billed total=30（prompt 20 未命中 + completion 10），应把 token 计数调低
  await settleUsage(emptyDb, redis, { ...payload, max_tokens: 1000 }, {
    promptTokens: 100,
    completionTokens: 50,
    estimatedCost: 1,
    actualPromptTokens: 200,
    actualCompletionTokens: 10,
    actualBilledTotalTokens: 30,
    actualCost: 0,
    ip: "127.0.0.1",
    ttlSeconds: 60,
  });

  const meta = JSON.parse(String(redis.lastEvalArgs[0])) as {
    incs: number[];
  };
  // SETTLE_SCRIPT 的 ARGV[0] 是 meta；第一个 token counter inc = -120
  assertEquals(meta.incs[0], -120);
});
