import { assertEquals } from "jsr:@std/assert@^1";
import type { RedisClient } from "../src/redis.ts";
import { incrByWithTtl, incrWithTtl } from "../src/redis.ts";

class FakeRedis implements RedisClient {
  data = new Map<string, number>();
  expires = new Map<string, number>();

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

  async eval(
    _script: string,
    _keys: string[],
    _args: (string | number)[],
  ): Promise<unknown> {
    return await Promise.resolve("ok");
  }
}

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
