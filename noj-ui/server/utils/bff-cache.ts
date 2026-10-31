/** 公开站点元信息缓存所需的最小 Redis 接口。 */
export interface BffCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<boolean>;
}

/** 公开站点元信息缓存 30 秒；缓存故障直接回源，未命中无需等待其他请求。 */
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
  try {
    const cached = await store.get(key);
    if (cached !== null) {
      const value = JSON.parse(cached) as T;
      report('hit');
      return value;
    }
  } catch {
    report('bypass');
    return load();
  }
  report('miss');
  const value = await load();
  await store.set(key, JSON.stringify(value), 30).catch(() => false);
  return value;
}
