export const SITE_META_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface SiteMetaCache {
  get<T>(
    key: string,
    load: () => Promise<T>,
    report?: (state: string) => void,
  ): Promise<T>;
  clear(): void;
}

/** 创建进程内 30 秒 TTL 缓存，用于匿名 /api/v1/site/meta；上游失败不缓存。 */
export function createSiteMetaCache(options: {
  ttlMs?: number;
  now?: () => number;
} = {}): SiteMetaCache {
  const ttlMs = options.ttlMs ?? SITE_META_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry>();

  return {
    async get<T>(
      key: string,
      load: () => Promise<T>,
      report: (state: string) => void = () => {},
    ): Promise<T> {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) {
        report('hit');
        return cached.value as T;
      }
      if (cached) entries.delete(key);
      report('miss');
      const value = await load();
      entries.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

const defaultSiteMetaCache = createSiteMetaCache();

/** 公开站点元信息进程内缓存 30 秒；未命中无需等待其他请求，上游失败不缓存。 */
export function cachedSiteMeta<T>(
  key: string,
  load: () => Promise<T>,
  report: (state: string) => void = () => {},
): Promise<T> {
  return defaultSiteMetaCache.get(key, load, report);
}
