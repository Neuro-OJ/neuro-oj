/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { MAX_CACHE_ENTRIES, SitemapCache } from '../server/utils/sitemap-cache.ts';

// ── 2026-09-21 修复：sitemap 缓存无界增长（Host 可控 + 无淘汰）──
// 触发条件：NUXT_SITE_URL 未配置时 origin 回退到请求 Host，攻击者循环发送
// 不同 Host 即可让缓存无界增长并触发上游扇出。

Deno.test('sitemap cache: 容量上限生效（无界增长已修复）', () => {
  const cache = new SitemapCache({ ttlMs: 60_000, maxEntries: 10 });
  for (let i = 0; i < 500; i++) {
    cache.set(`https://a${i}.evil.com`, { at: 1000, body: `body-${i}` });
  }
  assertEquals(cache.size, 10);
});

Deno.test('sitemap cache: LRU 淘汰最久未使用项', () => {
  const cache = new SitemapCache({ ttlMs: 60_000, maxEntries: 3 });
  cache.set('a', { at: 0, body: 'a' });
  cache.set('b', { at: 0, body: 'b' });
  cache.set('c', { at: 0, body: 'c' });
  // 访问 a，使其成为最近使用
  assertEquals(cache.get('a', 10)?.body, 'a');
  // 插入 d → 应淘汰最久未用的 b（而非刚访问过的 a）
  cache.set('d', { at: 0, body: 'd' });
  assertEquals(cache.get('b', 10), null);
  assertEquals(cache.get('a', 10)?.body, 'a');
  assertEquals(cache.get('c', 10)?.body, 'c');
  assertEquals(cache.get('d', 10)?.body, 'd');
});

Deno.test('sitemap cache: TTL 过期后 get 不再命中（条目保留供降级回退）', () => {
  const cache = new SitemapCache({ ttlMs: 1000 });
  cache.set('k', { at: 0, body: 'v' });
  assertEquals(cache.get('k', 999)?.body, 'v');
  assertEquals(cache.get('k', 1000), null);
  // 过期条目仍留在容器中（容量由 LRU 上限兜底），供 peekStale 降级回退
  assertEquals(cache.size, 1);
  assertEquals(cache.peekStale('k')?.body, 'v');
});

Deno.test('sitemap cache: 默认容量上限为有限值', () => {
  assertEquals(Number.isFinite(MAX_CACHE_ENTRIES), true);
  assertEquals(MAX_CACHE_ENTRIES > 0, true);
  const cache = new SitemapCache({ ttlMs: 1000 });
  for (let i = 0; i < MAX_CACHE_ENTRIES * 3; i++) {
    cache.set(`k${i}`, { at: 0, body: 'x' });
  }
  assertEquals(cache.size, MAX_CACHE_ENTRIES);
});

Deno.test('sitemap cache: 重复写同一键不增加条目数', () => {
  const cache = new SitemapCache({ ttlMs: 1000, maxEntries: 5 });
  for (let i = 0; i < 20; i++) cache.set('same', { at: i, body: 'x' });
  assertEquals(cache.size, 1);
});

Deno.test('sitemap cache: peekStale 返回过期条目供降级回退', () => {
  const cache = new SitemapCache({ ttlMs: 1000 });
  cache.set('k', { at: 0, body: 'full' });
  // get 在过期后不可用（新鲜度语义）
  assertEquals(cache.get('k', 5000), null);
  // peekStale 仍可拿到完整旧内容（降级分支用）
  assertEquals(cache.peekStale('k')?.body, 'full');
  assertEquals(cache.peekStale('missing'), null);
});

Deno.test('sitemap 路由: 降级分支回退旧缓存用 peekStale', async () => {
  const source = await Deno.readTextFile(
    new URL('../server/routes/sitemap.xml.ts', import.meta.url),
  );
  assertEquals(
    source.includes('cache.peekStale(origin)'),
    true,
    '降级分支必须用 peekStale 回退完整旧缓存（而非受 TTL 约束的 get）',
  );
});

Deno.test('sitemap 路由: 使用有界缓存而非裸 Map', async () => {
  const source = await Deno.readTextFile(
    new URL('../server/routes/sitemap.xml.ts', import.meta.url),
  );
  assertEquals(
    /new Map<string, \{ at: number; body: string \}>\(\)/.test(source),
    false,
    'sitemap 路由不得再使用无界的裸 Map 作为缓存',
  );
  assertEquals(
    source.includes('new SitemapCache('),
    true,
    'sitemap 路由必须使用有界 SitemapCache',
  );
});
