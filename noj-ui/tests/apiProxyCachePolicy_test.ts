/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert } from 'jsr:@std/assert@^1';

const nuxtConfigSource = await Deno.readTextFile(
  new URL('../nuxt.config.ts', import.meta.url),
);

Deno.test('通用 API 代理路由不启用 Nitro SWR 缓存', () => {
  const routeRulesStart = nuxtConfigSource.indexOf('routeRules:');
  const routeRulesEnd = nuxtConfigSource.indexOf('\n  },', routeRulesStart);
  const routeRules = nuxtConfigSource.slice(routeRulesStart, routeRulesEnd);

  assert(routeRulesStart >= 0, 'nuxt.config.ts 必须定义 routeRules');
  assert(routeRulesEnd > routeRulesStart, '无法解析 routeRules 配置范围');
  assert(!routeRules.includes('swr:'), '通用 API 代理不得配置 SWR，避免缓存上游响应或个性化数据');
});
