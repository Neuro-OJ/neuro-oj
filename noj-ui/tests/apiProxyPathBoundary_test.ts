//! Nitro 代理边界回归（2026-09-29 前端审计 U-1 / U-2）
//!
//! 两个缺陷同源：**用未规范化的 `event.path` 做判定**。h3 的 `event.path` 即 `req.url`，
//! 既**含 query 字符串**，又可能是**未归一化的编码路径**。
//!
//! - **U-1**：白名单 `event.path.startsWith('/api/v1/')` 被
//!   `/api/v1/%2e%2e%2f%2e%2e%2fmetrics` 绕过 → 随后的 `fetch()` 按 URL 规范归一化
//!   dot-segment，最终打到 noj-core **任意路径**（匿名可利用）。
//! - **U-2**：`event.path.endsWith('/api/v1/auth/login')` 被 `?x=1` 绕过 → 登录/改密的 JWT
//!   **原样回给 JS**，且该路径不设置 Cookie（破坏"JWT 只进 HttpOnly Cookie"的不变量）。
//!
//! 本文件用两段断言守护：① **机制级**——钉住 WHATWG URL 的归一化语义（修法所依赖的前提）；
//! ② **源码级**——断言 `[...slug].ts` 中的判定确实已改为规范化比较（与同目录既有
//! `apiProxyRedirect_test.ts` / `apiProxyCachePolicy_test.ts` 的源码断言风格一致）。

// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本（与同目录既有测试一致）
import { assert, assertEquals } from 'jsr:@std/assert@^1';

const PROXY_SRC = await Deno.readTextFile(
  new URL('../server/api/[...slug].ts', import.meta.url),
);

const SENTINEL = 'http://noj.internal';

Deno.test('U-1 机制：字面 dot-segment 被 URL 归一化；编码形态由「编码残留」纵深防御兜住', () => {
  // ① 字面 `..` 段：`new URL()` 会归一化 → prefix 校验即可拦下
  for (const literal of ['/api/v1/../../metrics', '/api/v1/../health']) {
    assertEquals(
      new URL(literal, SENTINEL).pathname.startsWith('/api/v1/'),
      false,
      `${literal} 归一化后应落在白名单之外`,
    );
  }
  // ② 编码形态（`%2e%2e%2f`）：WHATWG URL **不会**归一化它 —— 这正是修复初版的缺口，
  //    故 [...slug].ts 增加了「路径残留 %2e/%2f/%5c 即拒绝」的纵深防御。
  for (
    const encoded of [
      '/api/v1/%2e%2e%2f%2e%2e%2fmetrics',
      '/api/v1/..%2f..%2fhealth',
    ]
  ) {
    const pathname = new URL(encoded, SENTINEL).pathname;
    assertEquals(
      pathname.startsWith('/api/v1/'),
      true,
      `${encoded} 的 pathname 不经归一化（这正是需要纵深防御的原因）`,
    );
    assertEquals(
      /%(2e|2f|5c)/i.test(pathname),
      true,
      `${encoded} 必须被「编码残留」规则识别并拒绝`,
    );
  }
});

Deno.test('U-1 机制：合法的 v1 路径（含 query）仍通过白名单，且 query 被保留', () => {
  const u = new URL('/api/v1/problems?tag=x&page=2', SENTINEL);
  assert(u.pathname.startsWith('/api/v1/'), '合法 v1 路径不应被拒');
  assertEquals(u.search, '?tag=x&page=2', 'query 必须保留（否则破坏筛选/分页）');
  assertEquals(new URL(u.pathname, SENTINEL).origin, SENTINEL);
});

Deno.test('U-2 机制：event.path 含 query 时 endsWith 失效，而 pathname 比较仍成立', () => {
  const raw = '/api/v1/auth/login?x=1';
  assertEquals(
    raw.endsWith('/api/v1/auth/login'),
    false,
    '这正是 U-2 的绕过机制：含 query 时 endsWith 为假 → 拦截被跳过',
  );
  assertEquals(
    new URL(raw, SENTINEL).pathname,
    '/api/v1/auth/login',
    '改用 pathname 比较后，带 query 的请求仍能被正确识别为登录端点',
  );
});

Deno.test('U-1 源码：白名单已改为「URL 规范化 + origin/前缀」校验', () => {
  assert(
    PROXY_SRC.includes('new URL(event.path, apiBaseOrigin)'),
    '白名单必须用 new URL 规范化 event.path 后再校验',
  );
  assert(
    PROXY_SRC.includes('targetUrl.origin !== apiBaseOrigin'),
    '必须校验归一化后的 origin 与 apiBase 一致（防跨源跳转）',
  );
  assert(
    PROXY_SRC.includes("targetUrl.pathname.startsWith('/api/v1/')"),
    '前缀校验必须作用在**归一化后的 pathname** 上',
  );
  assert(
    /const target = \/\%\(2e\|2f\|5c\)\/i\.test\(targetUrl\.pathname\)/.test(
      PROXY_SRC,
    ),
    '必须对编码残留（%2e/%2f/%5c）做纵深防御：new URL 不会归一化编码形态',
  );
  // 反向断言：不得再出现"裸 event.path 前缀判定"
  assertEquals(
    /if \(!event\.path\.startsWith\('\/api\/v1\/'\)\)/.test(PROXY_SRC),
    false,
    '不得回退为对未规范化的 event.path 做前缀判定（U-1 回归）',
  );
});

Deno.test('U-2 源码：shouldInterceptAuth 已改为 pathname 比较', () => {
  assert(
    PROXY_SRC.includes('toUrlPathname(event.path)'),
    'shouldInterceptAuth 必须用 pathname 而非含 query 的 event.path',
  );
  assertEquals(
    /event\.path\.endsWith\('\/api\/v1\/auth/.test(PROXY_SRC),
    false,
    '不得回退为对 event.path 做 endsWith 判定（U-2 回归）',
  );
  assert(
    PROXY_SRC.includes("pathname === '/api/v1/auth/login'") &&
      PROXY_SRC.includes("pathname === '/api/v1/auth/change-password'"),
    '两个被拦截的认证端点都必须用等值比较',
  );
});
