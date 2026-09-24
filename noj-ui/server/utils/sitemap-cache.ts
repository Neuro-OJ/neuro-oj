// sitemap 的进程级缓存（2026-09-21 修复：无界 Map 导致 DoS）。
//
// 抽成独立模块的原因有二：
// 1. `server/routes/sitemap.xml.ts` 末尾调用 `defineEventHandler`（Nitro 自动
//    导入），直接在单测中 import 会因 `defineEventHandler is not defined` 失败；
// 2. 缓存容量/淘汰策略需要一个可被真实断言的地方（此前只有源码级正则断言）。
//
// ## 缺陷背景
//
// 缓存以 origin 为键。当 `NUXT_SITE_URL` 未配置时 origin 回退到请求的 `Host`
// 头（`resolveOrigin`），而 Host 由客户端控制。原实现只写不删：
//
//     const cache = new Map<string, { at: number; body: string }>();
//     cache.set(origin, { at: now, body });
//
// 攻击者对 `/sitemap.xml` 循环发送不同 Host（`a1.evil.com`、`a2.evil.com`…）
// 即可让 Map 无界增长；每个新键还会触发 `fetchAll` × 3 端点、每端点最多 10 页
// 的上游扇出。少量请求即可造成内存耗尽与上游打满。
//
// 修复：容量上限 + LRU 淘汰（Map 的插入序即访问序，命中时重新 set 刷新）。
// 生产配置 `NUXT_SITE_URL` 时全部请求共用同一键，容量上限不会生效。

/** 缓存容量上限。超出时淘汰最久未使用的键。 */
export const MAX_CACHE_ENTRIES = 100;

export interface SitemapCacheEntry {
  at: number;
  body: string;
}

export interface SitemapCacheOptions {
  /** 条目存活毫秒数。 */
  ttlMs: number;
  /** 容量上限（默认 {@link MAX_CACHE_ENTRIES}）。 */
  maxEntries?: number;
}

/** 有界的 sitemap 缓存：TTL + LRU 淘汰。 */
export class SitemapCache {
  private readonly entries = new Map<string, SitemapCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: SitemapCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_CACHE_ENTRIES);
  }

  /**
   * 读取未过期条目；命中时刷新 LRU 位置。
   *
   * 过期条目**不在此处删除**：降级分支（`peekStale`）需要它作为"上一次完整
   * 结果"的回退来源；容量由 LRU 上限兜底，无需依赖读取时清理。
   */
  get(key: string, now: number): SitemapCacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.at >= this.ttlMs) return null;
    // 刷新 LRU：删除后重新插入，把它移到 Map 迭代序末尾。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * 读取条目**即使已过期**（不删除、不刷新 LRU 之外的副作用）。
   *
   * 用途：上游不可达的降级分支需要回退到"上一次完整结果"，
   * 即便它已超过 TTL——返回"只有首页"的残缺 sitemap 比返回过期但完整的内容
   * 更糟。与 {@link get} 的"新鲜度"语义分离，避免降级回退被 TTL 静默取消。
   */
  peekStale(key: string): SitemapCacheEntry | null {
    return this.entries.get(key) ?? null;
  }

  /** 写入条目并维持容量上限。 */
  set(key: string, entry: SitemapCacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** 当前条目数（测试用）。 */
  get size(): number {
    return this.entries.size;
  }
}
