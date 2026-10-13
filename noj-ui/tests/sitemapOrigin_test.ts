/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
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
