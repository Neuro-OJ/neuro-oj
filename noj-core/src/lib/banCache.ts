/**
 * 60s TTL LRU 缓存（issue #102）。
 *
 * 用于缓存：
 * - `users.banned / banned_reason / banned_until`（按 userId 缓存）
 * - `ip_bans` 全表（缓存 ip_or_cidr 列表 + 过期筛选结果）
 *
 * 模式与 issue #99 system-settings 的 initSystemSettings 内存 Map 类似：
 * 启动期一次加载，写路径调 invalidate 立即失效。
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();

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
  return value;
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
