/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
// 与生产 SSR 共用同一个解析型净化器（node_modules 由 deno install 提供）
import sanitizeHtml from 'sanitize-html';
import { registerServerSanitizer, sanitizeHtmlSync, type SanitizeInput } from '../utils/sanitize.ts';
import { BENIGN_PAYLOADS, XSS_PAYLOADS } from './fixtures/xss-corpus.ts';

// 服务端路径：生产由 `server/plugins/rich-text-sanitizer.ts` 在 Nitro 启动时注册，
// 测试里直接注册同一实现（等价于 SSR 首屏所走的代码路径）。
registerServerSanitizer((html, options) => sanitizeHtml(html, options));

function sanitize(html: string, input: SanitizeInput = {}): string {
  return sanitizeHtmlSync(html, input);
}

/** 取所有 `href` / `src` 属性值（净化器输出由解析器序列化，引号形式固定）。 */
function urlAttributes(html: string): string[] {
  const values: string[] = [];
  const re = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(re)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return values;
}

/**
 * 逐个标签解析属性**名**（不看属性值）。
 *
 * 为什么不能对整串跑 `/\son[a-z]+=/`：净化器会把危险标记实体化后放进**属性值**
 * 里（例如 `title="&lt;img onerror=…&gt;"`），字符串级匹配会把"文本里的 onerror"
 * 误判成处理器。反序列化器保证属性值内的 `>` 已实体化，因此按标签切分是可靠的。
 */
function attributeNames(html: string): Array<{ tag: string; name: string }> {
  const out: Array<{ tag: string; name: string }> = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*\/?>/g;
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  for (const tagMatch of html.matchAll(tagRe)) {
    const tag = tagMatch[1]!.toLowerCase();
    for (const attrMatch of (tagMatch[2] ?? '').matchAll(attrRe)) {
      out.push({ tag, name: attrMatch[1]!.toLowerCase() });
    }
  }
  return out;
}

/**
 * 断言输出里没有**可执行**的 URL。
 *
 * 判据不是"字符串里没有 javascript 字样"，而是"属性值解析后命中的协议不在白名单内"：
 * 净化器可能把危险值整体删掉，也可能把 `java&#115;cript:` 这类变体序列化成
 * `java&amp;#115;cript:`（浏览器再解析时是字面量，不构成协议）。
 */
function assertNoExecutableUrl(html: string, label: string): void {
  for (const value of urlAttributes(html)) {
    // 属性值里若仍有 `&`，说明实体没有在解析阶段被还原成协议分隔符，按字面量处理
    const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
    if (!scheme) continue;
    assert(
      ['http', 'https', 'mailto', 'tel'].includes(scheme),
      `${label}: 输出残留可执行协议 "${scheme}" → ${value}（输出：${html}）`,
    );
  }
}

/** 断言输出里没有内联事件处理器**属性**（`on<name>=`）。 */
function assertNoEventHandlers(html: string, label: string): void {
  const offenders = attributeNames(html).filter((a) => /^on[a-z]+$/.test(a.name));
  assertEquals(
    offenders,
    [],
    `${label}: 输出残留内联事件处理器属性 ${offenders.map((a) => `<${a.tag} ${a.name}>`).join(', ')}（输出：${html}）`,
  );
}

// ── 审计 F1 语料：服务端净化必须全部判定为不可执行 ──────────────────
for (const payload of XSS_PAYLOADS) {
  Deno.test(`sanitize(server): 语料 ${payload.name} 不得留下可执行内容`, () => {
    const out = sanitize(payload.html);
    assertNoEventHandlers(out, payload.name);
    assertNoExecutableUrl(out, payload.name);
  });
}

// ── 审计 F1 的具体复现（显式断言，避免将来被"删除语料"顺手绕过） ──
Deno.test('sanitize(server): 省略分号的数字实体（审计 F1 绕过）不再存活', () => {
  const out = sanitize(
    '<a href="javascript&#58window.__audit=1;void(0)">click</a>',
  );
  assertEquals(urlAttributes(out), [], `危险 href 仍存在：${out}`);
  assertStringIncludes(out, 'click');
});

Deno.test('sanitize(server): 十六进制省略分号实体同样被剥离', () => {
  const out = sanitize('<a href="javascript&#x3Avoid(0)">hex</a>');
  assertEquals(urlAttributes(out), [], `危险 href 仍存在：${out}`);
});

// ── 行为语义 ────────────────────────────────────────────────────────
Deno.test('sanitize(server): script / style 连内容一起丢弃', () => {
  assertEquals(sanitize('<script>alert(1)</script>'), '');
  assertEquals(sanitize('<style>p{color:red}</style>y'), 'y');
});

Deno.test('sanitize(server): 未知标签丢标记留文本（不再转义成可见标签）', () => {
  // 旧实现把未知标签转义成可见文本（`&lt;foo&gt;`）；解析型净化改为丢标记留文本。
  // 两种都安全，这里固化新语义，避免有人把"转义分支"当成安全职责改回来。
  assertEquals(sanitize('<foo bar="a<b">hi</foo>'), 'hi');
  assertEquals(sanitize('<iframe src="https://evil.example"></iframe>'), '');
});

Deno.test('sanitize(server): 白名单外的属性被移除（含 style / 事件属性）', () => {
  assertEquals(sanitize('<div style="color:red">x</div>'), '<div>x</div>');
  assertEquals(sanitize('<p onclick="alert(1)">x</p>'), '<p>x</p>');
});

Deno.test('sanitize(server): 图片策略 —— 站内相对保留、外链降级为链接、未知协议丢弃', () => {
  // 站内相对路径：保留为图片并补 loading=lazy
  assertEquals(
    sanitize('<img src="/local.png" alt="站内">'),
    '<img src="/local.png" loading="lazy" alt="站内" />',
  );
  // http 外链：降级为链接
  assertEquals(
    sanitize('<img src="http://evil.example/x.png" alt="外链">'),
    '<a href="http://evil.example/x.png" rel="nofollow noopener noreferrer" target="_blank">外链</a>',
  );
  // https 外链：默认（不允许外链图片）降级为链接
  assertEquals(
    sanitize('<img src="https://cdn.example/x.png" alt="图">'),
    '<a href="https://cdn.example/x.png" rel="nofollow noopener noreferrer" target="_blank">图</a>',
  );
  // https 外链 + 允许外链图片：保留为图片并补 referrerpolicy
  assertEquals(
    sanitize('<img src="https://cdn.example/x.png" alt="图">', {
      allowExternalImages: true,
    }),
    '<img src="https://cdn.example/x.png" loading="lazy" referrerpolicy="no-referrer" alt="图" />',
  );
  // 未知协议：整体丢弃（不留空图片标签）
  assertEquals(sanitize('<img src="javascript:alert(1)">'), '<span></span>');
});

Deno.test('sanitize(server): 正常内容不被破坏', () => {
  for (const payload of BENIGN_PAYLOADS) {
    const out = sanitize(payload.html);
    assertStringIncludes(
      out,
      payload.html.includes('<img') ? '<img src="/local.png"' : payload.html.slice(0, 12),
      `${payload.name} 被意外改动：${out}`,
    );
    assertNoEventHandlers(out, payload.name);
  }
  // KaTeX 的 class 与 highlight.js 的 pre/code 结构必须完整保留
  assertStringIncludes(
    sanitize('<pre class="hljs"><code>x</code></pre>'),
    'class="hljs"',
  );
  assertStringIncludes(
    sanitize('<span class="katex"><span class="mord">x</span></span>'),
    'class="katex"',
  );
});

Deno.test('sanitize(server): 净化器未注册时 fail-closed 降级为纯文本', async () => {
  // 通过重新加载模块拿到"未注册"状态，验证降级分支不会输出原始 HTML
  const mod = await import(`../utils/sanitize.ts?fresh=${crypto.randomUUID()}`);
  const out = mod.sanitizeHtmlSync('<img src=x onerror=alert(1)>');
  assert(out.includes('&lt;img'), `未降级为纯文本：${out}`);
  assertEquals(out.includes('<img'), false, `输出仍含可解析标签：${out}`);
});
