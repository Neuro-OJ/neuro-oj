// deno-lint-ignore no-import-prefix -- 与既有 Deno 测试一致，由 deno.lock 固定断言库版本
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { createSiteMetaCache } from '../../server/utils/bff-cache.ts';

Deno.test('BFF 公共元信息进程内缓存命中，30 秒后回源，按上游键隔离', async () => {
  let now = 1_000;
  const cache = createSiteMetaCache({ now: () => now });
  let calls = 0;
  const states: string[] = [];
  const load = () => Promise.resolve({ data: ++calls });
  assertEquals(await cache.get('http://core-a:site-meta', load, (s) => states.push(s)), { data: 1 });
  assertEquals(await cache.get('http://core-a:site-meta', load, (s) => states.push(s)), { data: 1 });
  assertEquals(await cache.get('http://core-b:site-meta', load, (s) => states.push(s)), { data: 2 });
  now += 30_001;
  assertEquals(await cache.get('http://core-a:site-meta', load, (s) => states.push(s)), { data: 3 });
  assertEquals(states, ['miss', 'hit', 'miss', 'miss']);
});

Deno.test('BFF 并发未命中均可回源，无需等待填充锁', async () => {
  const cache = createSiteMetaCache();
  let calls = 0;
  const load = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 42;
  };
  assertEquals(await Promise.all(Array.from({ length: 5 }, () => cache.get('meta', load))), [
    42,
    42,
    42,
    42,
    42,
  ]);
  assertEquals(calls, 5);
});

Deno.test('BFF 上游失败不缓存，后续请求可重试', async () => {
  const cache = createSiteMetaCache();
  await assertRejects(() => cache.get('meta', () => Promise.reject(new Error('upstream'))));
  assertEquals(await cache.get('meta', () => Promise.resolve(42)), 42);
});
