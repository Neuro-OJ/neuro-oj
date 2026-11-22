/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert } from 'jsr:@std/assert@^1';

// ── §4.1 OAuth 302 被代理跟随导致登录不可用 ────────────────────────
//
// 回归点：非 SSE 分支的 `proxyRequest(event, target)` 未传 fetchOptions，h3 的
// sendProxy 用 ofetch 且不设 redirect 默认值 → 平台默认 follow，代理会自己跟随上游
// 302（OAuth 授权跳转），把第三方页面回吐给浏览器，用户在回调端点之前就停住了。
//
// 这里做**源码级**断言：每个 proxyRequest 调用点都必须在附近显式声明
// `redirect: 'manual'`。新增加代理透传点时若忘了这条语义，测试会失败。

const source = await Deno.readTextFile(
  new URL('../server/api/[...slug].ts', import.meta.url),
);

Deno.test('API 代理：每个 proxyRequest 调用点都显式禁用自动重定向', () => {
  const callSites: number[] = [];
  const needle = 'proxyRequest(';
  let idx = source.indexOf(needle);
  while (idx >= 0) {
    callSites.push(idx);
    idx = source.indexOf(needle, idx + needle.length);
  }
  assert(callSites.length > 0, '未找到 proxyRequest 调用点（代理实现可能已重构，请同步本测试）');

  for (const at of callSites) {
    const window = source.slice(at, at + 400);
    assert(
      window.includes("redirect: 'manual'"),
      `proxyRequest 调用点（偏移 ${at}）缺少 redirect: 'manual'：` +
        `上游 302（OAuth 跳转等）会被代理跟随，浏览器永远到不了目标端点。\n` +
        `上下文：${window.slice(0, 200)}`,
    );
  }
});

Deno.test('API 代理：SSE 与非 SSE 分支的重定向语义一致', () => {
  // SSE 分支（proxySseRequest 内部 fetch）此前已设 redirect manual，用它作为对照
  assert(
    source.includes("redirect: 'manual'"),
    '代理层必须至少有一处显式 redirect: manual',
  );
  assert(
    source.includes('fetchOptions'),
    '非 SSE 分支应通过 fetchOptions 传递 redirect 语义',
  );
});
