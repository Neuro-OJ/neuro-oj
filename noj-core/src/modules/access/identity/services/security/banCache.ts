/**
 * 60s TTL LRU 缓存（issue #102）。
 *
 * 用于缓存：
 * - `users.banned / banned_reason / banned_until`（按 userId 缓存）
 * - `ip_bans` 全表（缓存 ip_or_cidr 列表 + 过期筛选结果）
 *
 * 模式与 issue #99 system-settings 的 initSystemSettings 内存 Map 类似：
 * 启动期一次加载，写路径调 invalidate 立即失效。
 *
 * 安全限制：MAX_CACHE_SIZE（5000）防止 Map 无限增长。
 * 写入时若超过 CLEANUP_THRESHOLD（4000），触发惰性驱逐：
 * 1. 先扫过期条目
 * 2. 若仍超 MAX_CACHE_SIZE，砍掉最旧的 25%
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

/** 缓存上限（超过此数量时驱逐最旧条目） */
const MAX_CACHE_SIZE = 5_000;
/** 触发惰性驱逐的阈值（写入时 cache.size > 此值则执行清理） */
const CLEANUP_THRESHOLD = 4_000;

/** 读取缓存（命中且未过期则直接返；miss 或过期则 fetcher 取值后写入）。 */
export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = 60_000,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }

  const value = await fetcher();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });

  // 惰性驱逐：写入后检查是否超出阈值
  lazyEvict();

  return value;
}

/**
 * 惰性驱逐：先扫过期条目，若仍超 MAX_CACHE_SIZE 则砍最旧的 25%。
 * 仅在 cache.size > CLEANUP_THRESHOLD 时执行，高频路径不增加开销。
 */
function lazyEvict(): void {
  if (cache.size <= CLEANUP_THRESHOLD) return;

  const now = Date.now();

  // Phase 1：清除过期条目
  for (const [k, entry] of cache) {
    if (cache.size <= MAX_CACHE_SIZE) break;
    if (entry.expiresAt <= now) cache.delete(k);
  }

  // Phase 2：清除过期后仍然超限 → 砍最旧的 25%
  if (cache.size > MAX_CACHE_SIZE) {
    const toDelete = Math.ceil(MAX_CACHE_SIZE * 0.25);
    const iter = cache.keys();
    for (let i = 0; i < toDelete; i++) {
      const k = iter.next().value;
      if (k) cache.delete(k);
    }
  }
}

/**
 * 失效缓存：
 * - 不传参数 → 清空全部
 * - 仅 userId → 失效该用户 ban 状态
 * - 仅 ipOrCidr → 失效该 IP 黑名单条目（同时清空 ip_bans 全表缓存，因为列表已变）
 * - 都传 → 两者都失效
 */
export function invalidateBanCache(opts: {
  userId?: string;
  ipOrCidr?: string;
  all?: boolean;
} = {}): void {
  if (opts.all) {
    cache.clear();
    return;
  }
  if (opts.userId) cache.delete(`user:${opts.userId}`);
  if (opts.ipOrCidr !== undefined) {
    // 任何 IP/CIDR 变化都让 ip_bans 全表缓存失效（简单一致）
    cache.delete("ip_bans:all");
    cache.delete("ip_bans:detail");
  }
}

/** 测试用：清空全部缓存。 */
export function _resetBanCacheForTest(): void {
  cache.clear();
}
