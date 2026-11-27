// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import { CLIENT_ONLY_ROUTES, withClientOnlyRouteRules } from '../../utils/ssr-routes.ts';

Deno.test('CLIENT_ONLY_ROUTES：无重复条目且覆盖关键客户端路由', () => {
  assertEquals(new Set(CLIENT_ONLY_ROUTES).size, CLIENT_ONLY_ROUTES.length);
  assertEquals(CLIENT_ONLY_ROUTES.includes('/admin/**'), true);
  assertEquals(CLIENT_ONLY_ROUTES.includes('/d/*/editor/**'), true);
  assertEquals(CLIENT_ONLY_ROUTES.includes('/d/*/members'), true);
  assertEquals(CLIENT_ONLY_ROUTES.includes('/join'), true);
  assertEquals(CLIENT_ONLY_ROUTES.includes('/my/submissions/**'), true);
});

Deno.test('withClientOnlyRouteRules：合并自定义响应头时保留 ssr: false', () => {
  const merged = withClientOnlyRouteRules({
    '/my/submissions': { ssr: true, headers: { 'cache-control': 'no-store' } },
    '/my/submissions/**': { headers: { 'cache-control': 'no-store' } },
    '/join': { headers: { 'cache-control': 'no-store' } },
  });

  assertEquals(merged['/my/submissions'], {
    ssr: true,
    headers: { 'cache-control': 'no-store' },
  });
  assertEquals(merged['/my/submissions/**'], {
    ssr: false,
    headers: { 'cache-control': 'no-store' },
  });
  assertEquals(merged['/join'], {
    ssr: false,
    headers: { 'cache-control': 'no-store' },
  });
  assertEquals(merged['/d/*/settings'], { ssr: false });
});
