import { BffError } from './bff-request.ts';

/** 最小 Redis 接口，便于验证跨副本缓存与锁，不依赖进程内缓存。 */
export interface BffCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number, onlyIfAbsent?: boolean): Promise<boolean>;
  unlock(key: string, owner: string): Promise<void>;
}

/** 仅供公开站点元信息使用；故障绕过缓存，锁只合并同一公开键的填充。 */
export async function cachedSiteMeta<T>(
  store: BffCacheStore | null,
  key: string,
  load: () => Promise<T>,
  report: (state: string) => void = () => {},
): Promise<T> {
  if (!store) {
    report('bypass');
    return load();
  }
  const owner = crypto.randomUUID();
  let locked = false;
  try {
    const cached = await store.get(key);
    if (cached !== null) {
      report('hit');
      return JSON.parse(cached) as T;
    }
    report('miss');
    locked = await store.set(`${key}:lock`, owner, 2, true);
    if (!locked) {
      // 有界等待慢副本填充；不能让等待者同时回源放大 Core 压力。
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const filled = await store.get(key);
        if (filled !== null) {
          report('coalesced');
          return JSON.parse(filled) as T;
        }
      }
    }
  } catch {
    report('bypass');
    return load();
  }
  if (!locked) {
    report('pending');
    throw new BffError(504, { error: '公共元信息正在加载，请稍后重试', code: 'BFF_CACHE_PENDING' });
  }
  try {
    const value = await load();
    if (locked) await store.set(key, JSON.stringify(value), 30).catch(() => false);
    return value;
  } finally {
    if (locked) await store.unlock(`${key}:lock`, owner).catch(() => {});
  }
}
