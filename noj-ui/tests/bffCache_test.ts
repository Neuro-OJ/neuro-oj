// deno-lint-ignore no-import-prefix -- 与既有 Deno 测试一致，由 deno.lock 固定断言库版本
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { type BffCacheStore, cachedSiteMeta } from '../server/utils/bff-cache.ts';

function cache() {
  const values = new Map<string, { value: string; expires: number }>();
  let now = 0;
  const store: BffCacheStore = {
    get: (key) => Promise.resolve((values.get(key)?.expires ?? 0) > now ? values.get(key)!.value : null),
    set: (key, value, ttl) => {
      values.set(key, { value, expires: now + ttl * 1000 });
      return Promise.resolve(true);
    },
  };
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

Deno.test('BFF 公共元信息跨请求命中，30 秒后回源，命名空间隔离', async () => {
  const { store, advance } = cache();
  let calls = 0;
  const load = () => Promise.resolve({ data: ++calls });
  assertEquals(await cachedSiteMeta(store, 'deploy-a:meta', load), { data: 1 });
  assertEquals(await cachedSiteMeta(store, 'deploy-a:meta', load), { data: 1 });
  assertEquals(await cachedSiteMeta(store, 'deploy-b:meta', load), { data: 2 });
  advance(30_001);
  assertEquals(await cachedSiteMeta(store, 'deploy-a:meta', load), { data: 3 });
});

Deno.test('BFF 并发未命中均可回源，无需等待填充锁', async () => {
  const { store } = cache();
  let calls = 0;
  const load = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 42;
  };
  assertEquals(await Promise.all(Array.from({ length: 5 }, () => cachedSiteMeta(store, 'meta', load))), [
    42,
    42,
    42,
    42,
    42,
  ]);
  assertEquals(calls, 5);
});

Deno.test('BFF Redis 读取故障绕过缓存', async () => {
  const broken: BffCacheStore = {
    get: () => Promise.reject(new Error('offline')),
    set: () => Promise.reject(new Error('offline')),
  };
  const states: string[] = [];
  assertEquals(await cachedSiteMeta(broken, 'meta', () => Promise.resolve(42), (state) => states.push(state)), 42);
  assertEquals(states, ['bypass']);
});

Deno.test('BFF 缓存写入故障仍返回已加载的结果，不重复回源', async () => {
  const store: BffCacheStore = {
    get: () => Promise.resolve(null),
    set: () => Promise.reject(new Error('offline')),
  };
  let calls = 0;
  assertEquals(await cachedSiteMeta(store, 'meta', () => Promise.resolve(++calls)), 1);
  assertEquals(calls, 1);
});

Deno.test('BFF 上游失败不缓存，后续请求可重试', async () => {
  const { store } = cache();
  await assertRejects(() => cachedSiteMeta(store, 'meta', () => Promise.reject(new Error('upstream'))));
  assertEquals(await store.get('meta'), null);
  assertEquals(await cachedSiteMeta(store, 'meta', () => Promise.resolve(42)), 42);
});

Deno.test('BFF 未配置缓存时直接回源', async () => {
  assertEquals(await cachedSiteMeta(null, 'meta', () => Promise.resolve(42)), 42);
});
