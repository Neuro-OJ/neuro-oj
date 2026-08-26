/**
 * Redis 客户端与限流计数工具。
 */
import IORedis from "ioredis";

/**
 * 本地 Redis 客户端接口（避免 ioredis 在 Deno 下类型解析问题）。
 */
export interface RedisClient {
  incr(key: string): Promise<number>;
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  /** 执行 Lua 脚本；keys 为 KEYS，args 为 ARGV */
  eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown>;
}

/** 创建 Redis 客户端适配器，统一暴露限流所需的最小操作集。 */
export function createRedis(redisUrl: string): RedisClient {
  // @ts-ignore - ioredis 构造函数类型在 Deno 中解析受限
  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  return {
    incr: (key) => redis.incr(key),
    incrby: (key, amount) => redis.incrby(key, amount),
    expire: (key, seconds) => redis.expire(key, seconds),
    get: (key) => redis.get(key),
    set: (key, value) => redis.set(key, value),
    eval: (script, keys, args) =>
      redis.eval(script, keys.length, ...keys, ...args),
  };
}

/** 原子自增并设置 TTL（首次自增时设置） */
export async function incrWithTtl(
  redis: RedisClient,
  key: string,
  ttlSeconds: number,
): Promise<number> {
  const value = await redis.incr(key);
  if (value === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return value;
}

/** 原子自增指定数量并设置 TTL（首次自增时设置） */
export async function incrByWithTtl(
  redis: RedisClient,
  key: string,
  amount: number,
  ttlSeconds: number,
): Promise<number> {
  const value = await redis.incrby(key, amount);
  if (value === amount) {
    await redis.expire(key, ttlSeconds);
  }
  return value;
}
