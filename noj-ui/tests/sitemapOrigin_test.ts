/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { resolveOrigin, sanitizeHost } from '../server/utils/sitemap-origin.ts';

// ── §4.2 sitemap 缓存投毒修复 ──────────────────────────────────────

Deno.test('sitemap: 配置了权威域名时忽略请求 Host（不可投毒）', () => {
  assertEquals(
    resolveOrigin('https://noj.example.com', 'http', 'evil.com'),
    'https://noj.example.com',
  );
  // 结尾斜杠被规范化
  assertEquals(
    resolveOrigin('https://noj.example.com/', null, 'evil.com'),
    'https://noj.example.com',
  );
});

Deno.test('sitemap: 未配置权威域名时回退到校验过的 Host', () => {
  assertEquals(resolveOrigin('', 'https', 'noj.local:3000'), 'https://noj.local:3000');
  // 非 https 一律按 http（仅本地开发路径）
  assertEquals(resolveOrigin(undefined, 'http', 'localhost:3000'), 'http://localhost:3000');
});

Deno.test('sitemap: 非法 Host 拒绝而非拼接', () => {
  assertEquals(sanitizeHost('evil.com/../x'), null);
  assertEquals(sanitizeHost('a b.com'), null);
  assertEquals(sanitizeHost('user@host'), null);
  assertEquals(sanitizeHost('host?x=1'), null);
  assertEquals(sanitizeHost(''), null);
  assertEquals(sanitizeHost(undefined), null);
  assertEquals(sanitizeHost('x'.repeat(300)), null);
  assertEquals(resolveOrigin('', 'https', 'evil.com/x'), null);
});

Deno.test('sitemap: 缓存按 origin 分键（源码级断言）', async () => {
  const source = await Deno.readTextFile(
    new URL('../server/routes/sitemap.xml.ts', import.meta.url),
  );
  // 旧的单值缓存 `let cache: { at, body } | null` 会把任意 Host 的结果写进同一格
  assert(
    !/let cache: \{ at: number; body: string \} \| null/.test(source),
    'sitemap 缓存必须是按 origin 分键的 Map，不能是单值缓存',
  );
  assert(source.includes('cache.set(origin'), '缓存写入必须带 origin 键');

  // 降级分支（上游不可达）不得写缓存——用花括号配对取出该块本身再断言
  const start = source.indexOf('if (degraded) {');
  assert(start >= 0, '未找到 degraded 分支（实现已重构，请同步本测试）');
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const degradedBlock = source.slice(start, end + 1);
  assert(
    !degradedBlock.includes('cache.set('),
    '上游不可达的降级结果不得写入缓存',
  );
});
