// deno-lint-ignore no-import-prefix -- 与既有 Deno 测试一致，由 deno.lock 固定断言库版本
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { BffError, coreUrl, createCoreReader } from '../server/utils/bff-request.ts';

Deno.test('BFF 路径白名单拒绝越界、编码分隔符和跨 origin', () => {
  for (const path of ['/api/v1/../../metrics', '/api/v1/%2e%2e%2fmetrics', '//evil.test/api/v1/auth/me']) {
    let rejected = false;
    try {
      coreUrl('http://core:8000', path);
    } catch {
      rejected = true;
    }
    assert(rejected, path);
  }
});

Deno.test('BFF 同请求相同 GET 去重，查询顺序无关，不转发 Cookie 和伪造 Authorization', async () => {
  let calls = 0;
  const reader = createCoreReader({
    base: 'http://core:8000',
    token: 'real-token',
    signal: new AbortController().signal,
    headers: { cookie: 'secret-cookie', authorization: 'forged', 'x-real-ip': '127.0.0.1' },
    fetcher: ((_url, options) => {
      calls++;
      const headers = new Headers(options?.headers);
      assertEquals(headers.get('authorization'), 'Bearer real-token');
      assertEquals(headers.get('cookie'), null);
      assertEquals(options?.redirect, 'manual');
      return Promise.resolve(Response.json({ data: 42 }));
    }) as typeof fetch,
  });
  assertEquals(await Promise.all([reader.get('/api/v1/test?a=1&b=2'), reader.get('/api/v1/test?b=2&a=1')]), [{
    data: 42,
  }, { data: 42 }]);
  assertEquals(calls, 1);
});

Deno.test('BFF 并发不超过四路，独立渲染请求不共享用户或结果', async () => {
  let active = 0, peak = 0;
  const make = (token: string) =>
    createCoreReader({
      base: 'http://core',
      token,
      signal: new AbortController().signal,
      fetcher: (async (_url, options) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return Response.json({ viewer: new Headers(options?.headers).get('authorization') });
      }) as typeof fetch,
    });
  const first = make('a');
  const values = await Promise.all(Array.from({ length: 12 }, (_, i) => first.get(`/api/v1/items/${i}`)));
  assertEquals(values.length, 12);
  assertEquals(peak, 4);
  assertEquals(await make('b').get('/api/v1/items/0'), { viewer: 'Bearer b' });
});

Deno.test('BFF 超时取消在飞和排队任务，队列不再访问上游', async () => {
  const controller = new AbortController();
  let started = 0;
  const reader = createCoreReader({
    base: 'http://core',
    signal: controller.signal,
    concurrency: 1,
    fetcher: ((_url, options) =>
      new Promise((_resolve, reject) => {
        started++;
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      })) as typeof fetch,
  });
  const results = Promise.allSettled(Array.from({ length: 5 }, (_, i) => reader.get(`/api/v1/items/${i}`)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert((await results).every((r) => r.status === 'rejected' && r.reason.statusCode === 504));
  assertEquals(started, 1);
});

Deno.test('BFF 保留 401/403/404/429 和诊断头，错误不重试、不跟随重定向', async () => {
  for (const status of [401, 403, 404, 429, 302]) {
    let calls = 0;
    const reader = createCoreReader({
      base: 'http://core',
      signal: new AbortController().signal,
      fetcher: (() => {
        calls++;
        return Promise.resolve(
          Response.json({ error: '具体原因', code: 'TEST', request_id: 'request' }, {
            status,
            headers: { 'retry-after': '10', 'set-cookie': 'secret' },
          }),
        );
      }) as typeof fetch,
    });
    const error = await assertRejects(() => reader.get('/api/v1/test'), BffError);
    assertEquals(error.statusCode, status === 302 ? 502 : status);
    assertEquals(error.data.code, 'TEST');
    assertEquals(error.headers, { 'retry-after': '10' });
    assertEquals(calls, 1);
  }
});
