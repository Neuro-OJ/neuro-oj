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
    PROXY_SRC.includes('shouldInterceptAuth(event, targetUrl.pathname)'),
    'shouldInterceptAuth 必须用规范化后的 pathname 而非含 query 的 event.path',
  );
  assertEquals(
    /shouldInterceptAuth\([^)]*event\.path/.test(PROXY_SRC),
    false,
    'shouldInterceptAuth 不得接收含 query 的 event.path（pathname 取自已解析的 targetUrl）',
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

// ── 内部端点不得经公网代理到达 noj-core ──────────────────────────────
//
// `/api/v1/internal/*`（排空、内部服务端点）只允许容器内网直连：CLI 经
// `docker compose run core ...` 访问 `http://core:8000`，judge/gateway 走内网。
// 公网请求经 nginx → Nitro 代理时必须在**规范化后的 pathname** 上直接 404，
// 不得进入认证拦截 / SSE / 普通转发任一分支。

/** 与 [...slug].ts 一致的 internal 判定规则（机制级复刻，源码级另行断言）。 */
const INTERNAL_RE = /^\/api\/v1\/+internal(?:\/|$)/i;

function blockedAsInternal(rawPath: string): boolean {
  const pathname = new URL(rawPath, SENTINEL).pathname;
  if (INTERNAL_RE.test(pathname)) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded !== pathname && INTERNAL_RE.test(decoded);
}

Deno.test('internal：内部端点及其变体一律判定为拦截', () => {
  for (
    const raw of [
      '/api/v1/internal/drain/status',
      '/api/v1/internal/llm/quota-caps',
      '/api/v1/internal',
      '/api/v1/internal/?x=1',
      // 大小写变体：pathname 保留原始大小写，规则须不区分大小写
      '/api/v1/Internal/drain/status',
      // 百分号编码的 `i`：解码后命中
      '/api/v1/%69nternal/x',
      // 双斜杠：pathname 不归一化 `//`
      '/api/v1//internal/x',
    ]
  ) {
    assert(blockedAsInternal(raw), `${raw} 必须被 internal 规则拦截`);
  }
});

Deno.test('internal 机制：大小写敏感说明 —— WHATWG URL 不改写路径大小写', () => {
  assertEquals(
    new URL('/api/v1/Internal/x', SENTINEL).pathname,
    '/api/v1/Internal/x',
    'pathname 保留原始大小写，因此必须用 /i 规则显式拦截',
  );
  assertEquals(
    new URL('/api/v1/%69nternal/x', SENTINEL).pathname,
    '/api/v1/%69nternal/x',
    'new URL 不解码 %69，因此需要解码后再判定',
  );
  assertEquals(
    new URL('/api/v1//internal/x', SENTINEL).pathname,
    '/api/v1//internal/x',
    'new URL 不折叠双斜杠，因此规则须用 /+ 匹配任意斜杠数',
  );
});

Deno.test('internal 机制的误伤边界：合法 v1 路径与相似前缀不被拦截', () => {
  for (
    const raw of [
      '/api/v1/problems',
      '/api/v1/internalized/x',
      '/api/v1/public/internal/x',
    ]
  ) {
    assertEquals(blockedAsInternal(raw), false, `${raw} 不应被误伤`);
  }
});

Deno.test('internal 源码：白名单校验后对规范化 pathname 做 internal 拦截', () => {
  assert(
    PROXY_SRC.includes('isInternalApiPath(targetUrl.pathname)'),
    'internal 判定必须作用在规范化后的 pathname 上（防 %2f/大小写/双斜杠绕过）',
  );
  assert(
    /const INTERNAL_API_PATH = \/\^\\\/api\\\/v1\\\/\+internal/.test(
      PROXY_SRC,
    ),
    'internal 规则须容忍多个斜杠（/+）并位于 /api/v1/ 前缀之内',
  );
  assert(
    PROXY_SRC.includes('decodeURIComponent(pathname)'),
    'internal 规则须对编码形态（如 %69nternal）解码后再判定',
  );
  // 判定必须位于白名单 if 中且在 SSE / 普通转发调用之前执行
  // （函数定义在文件上方，这里须匹配**调用点**，故带上 `await ` 前缀）
  const guardAt = PROXY_SRC.indexOf('isInternalApiPath(targetUrl.pathname)');
  assert(guardAt >= 0, '未找到 internal 拦截点');
  for (const later of ['await proxySseRequest(', 'proxyRequest(event, target']) {
    const idx = PROXY_SRC.indexOf(later);
    assert(
      idx > guardAt,
      `${later} 必须位于 internal 拦截点之后（SSE 与普通分支都被覆盖）`,
    );
  }
});
