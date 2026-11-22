import { Redis } from 'ioredis';
import type { BffCacheStore } from '../utils/bff-cache';

/** 只共享连接；缓存内容位于 Redis。 */
export default defineNitroPlugin((app) => {
  const url = useRuntimeConfig().bffRedisUrl as string;
  if (!url) return;
  const redis = new Redis(url, {
    connectTimeout: 150,
    commandTimeout: 150,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 1000, 5000),
  });
  // 连接错误由请求侧绕过缓存，不输出可能携带凭据的 URL/异常。
  redis.on('error', () => {});
  const store: BffCacheStore = {
    get: (key) => redis.get(key),
    set: async (key, value, ttl) => (await redis.set(key, value, 'EX', ttl)) === 'OK',
  };
  app.hooks.hook('request', (event) => {
    event.context.bffCacheStore = store;
  });
  app.hooks.hook('close', () => {
    redis.disconnect();
  });
});
