/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertStringIncludes } from 'jsr:@std/assert@^1';

const middleware = await Deno.readTextFile(
  new URL('../server/middleware/security-headers.ts', import.meta.url),
);
const securityHeaders = await Deno.readTextFile(
  new URL('../server/utils/security-headers.ts', import.meta.url),
);
const nginx = await Deno.readTextFile(
  new URL('../../deploy/nginx/default.conf', import.meta.url),
);

Deno.test('Nitro 直连提供强制 CSP 和基础安全头', () => {
  for (
    const header of [
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
    ]
  ) {
    assertStringIncludes(securityHeaders, `'${header}'`);
  }
  assert(!securityHeaders.includes('Content-Security-Policy-Report-Only'));
  assert(!securityHeaders.includes('report-uri'));
  assert(!securityHeaders.includes('Strict-Transport-Security'));
  assertStringIncludes(middleware, "from '../utils/security-headers.ts'");
});

Deno.test('Nginx 隐藏上游安全头后只输出一份策略且不设置 HSTS', () => {
  assertStringIncludes(nginx, 'proxy_hide_header Content-Security-Policy;');
  assert(
    !nginx.includes('Content-Security-Policy-Report-Only'),
    'Nginx 不应再输出或隐藏 Report-Only CSP',
  );
  assertStringIncludes(nginx, 'add_header Content-Security-Policy ');
  assert(!nginx.includes('Strict-Transport-Security'));
});
