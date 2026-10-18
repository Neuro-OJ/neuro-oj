// deno-lint-ignore no-import-prefix -- 与既有 Deno 测试一致，由 deno.lock 固定断言库版本
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { type BffCacheStore, cachedSiteMeta } from '../server/utils/bff-cache.ts';

function cache() {
  const values = new Map<string, { value: string; expires: number }>();
  let now = 0;
  const store: BffCacheStore = {
    get: (key) => Promise.resolve((values.get(key)?.expires ?? 0) > now ? values.get(key)!.value : null),
    set: (key, value, ttl, nx) => {
      if (nx && (values.get(key)?.expires ?? 0) > now) return Promise.resolve(false);
      values.set(key, { value, expires: now + ttl * 1000 });
      return Promise.resolve(true);
    },
    unlock: (key, owner) => {
      if (values.get(key)?.value === owner) values.delete(key);
      return Promise.resolve();
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

Deno.test('BFF 并发缓存填充由共享锁合并', async () => {
  const { store } = cache();
  let calls = 0;
  const load = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return 42;
  };
  assertEquals(await Promise.all(Array.from({ length: 5 }, () => cachedSiteMeta(store, 'meta', load))), [
    42,
    42,
    42,
    42,
    42,
  ]);
  assertEquals(calls, 1);
});

Deno.test('BFF 慢填充超时的等待者降级，不重复冲击上游', async () => {
  let calls = 0;
  const store: BffCacheStore = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(false),
    unlock: () => Promise.resolve(),
  };
  await assertRejects(() =>
    cachedSiteMeta(store, 'meta', () => {
      calls++;
      return Promise.resolve(42);
    })
  );
  assertEquals(calls, 0);
});

Deno.test('BFF Redis 故障绕过缓存，失败不缓存且释放填充锁', async () => {
  const broken: BffCacheStore = {
    get: () => Promise.reject(new Error('offline')),
    set: () => Promise.reject(new Error('offline')),
    unlock: () => Promise.reject(new Error('offline')),
  };
  assertEquals(await cachedSiteMeta(broken, 'meta', () => Promise.resolve(42)), 42);
  const { store } = cache();
  await assertRejects(() => cachedSiteMeta(store, 'meta', () => Promise.reject(new Error('upstream'))));
  assertEquals(await store.get('meta'), null);
  assertEquals(await store.get('meta:lock'), null);
});
