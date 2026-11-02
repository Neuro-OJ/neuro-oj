/**
 * SSR 富文本净化回归语料（2026-11-02 rc/v0.11 审计 F1）。
 *
 * 每条载荷都必须被**服务端解析型净化器**（`sanitize-html`）与**客户端 DOMPurify**
 * 同时判定为"不含可执行 URL、不含内联事件处理器"。两份实现共享 `utils/sanitize-policy.ts`
 * 的政策，语料共享本文件，避免两端口径再次分叉。
 *
 * 来历：
 * - `entity-*`：审计 F1 的实际绕过（`&#58` 省略分号的数字实体）。旧正则净化器只识别
 *   带分号的实体，于是 `javascript&#58alert(1)` 通过协议检查，浏览器解析成
 *   `javascript:` URL，SSR 首屏点击即执行。
 * - `scheme-*`：协议变体（大小写、前导空白/控制字符、命名实体、编码协议名）。
 * - `mxss-*`：解析器往返（serialize → 浏览器 reparse）相关的构造。
 * - `attr-*`：属性逃逸（无引号值、单引号值、标签内嵌 `<`）。
 * - `img-*`：图片策略（站内相对保留、非 https 降级为链接、未知协议丢弃）。
 */
export interface XssPayload {
  /** 载荷名称（断言失败时的定位标识）。 */
  name: string;
  /** 待净化的 HTML 片段。 */
  html: string;
}

/** 必须被净化器判定为不可执行的载荷。 */
export const XSS_PAYLOADS: readonly XssPayload[] = [
  // ── 审计 F1 实际绕过：省略分号的数字实体 ──
  {
    name: 'entity-dec-no-semicolon',
    html: '<a href="javascript&#58window.__audit=1;void(0)">click</a>',
  },
  {
    name: 'entity-hex-no-semicolon',
    html: '<a href="javascript&#x3Avoid(0)">hex</a>',
  },
  {
    name: 'entity-dec-semicolon',
    html: '<a href="javascript&#58;alert(1)">semi</a>',
  },
  {
    name: 'entity-fully-encoded-scheme',
    html: '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">enc</a>',
  },
  {
    name: 'entity-named-colon',
    html: '<a href="javascript&colon;alert(1)">named</a>',
  },

  // ── 协议变体 ──
  { name: 'scheme-uppercase', html: '<a href="JaVaScRiPt:alert(1)">u</a>' },
  {
    name: 'scheme-leading-space',
    html: '<a href=" javascript:alert(1)">space</a>',
  },
  {
    name: 'scheme-newline-inside',
    html: '<a href="java\nscript:alert(1)">nl</a>',
  },
  {
    name: 'scheme-tab-inside',
    html: '<a href="java\tscript:alert(1)">tab</a>',
  },
  {
    name: 'scheme-vbscript',
    html: '<a href="vbscript:msgbox(1)">vb</a>',
  },
  {
    name: 'scheme-file',
    html: '<a href="file:///etc/passwd">file</a>',
  },
  {
    name: 'scheme-data-text-html',
    html: '<a href="data:text/html,<script>alert(1)</script>">data</a>',
  },
  {
    name: 'scheme-protocol-relative',
    html: '<img src="//evil.example/x.png">',
  },

  // ── 属性逃逸 ──
  {
    name: 'attr-unquoted-doublequote',
    html: '<img src=x"onerror="alert(1)>',
  },
  {
    name: 'attr-single-quoted',
    html: "<img src='a'onerror='alert(1)'>",
  },
  {
    name: 'attr-inside-unknown-tag',
    html: '<foo bar="<img src=x onerror=alert(1)//>">',
  },
  {
    name: 'attr-title-event',
    html: '<div title=x"onmouseover="alert(1)">x</div>',
  },
  {
    name: 'attr-onclick-kept-off',
    html: '<p onclick="alert(1)">x</p>',
  },

  // ── mXSS 构造 ──
  {
    name: 'mxss-math-mglyph',
    html:
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=x&Tab;onerror=alert(1)&gt;">',
  },
  {
    name: 'mxss-svg-animate',
    html: '<svg><animate onbegin=alert(1)></animate></svg>',
  },
  {
    name: 'mxss-comment-wrapped',
    html: '<div><!--<img src=x onerror=alert(1)>--></div>',
  },
  {
    name: 'mxss-noscript',
    html: '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  },
  {
    name: 'mxss-script-in-style',
    html: '<style><img src=x onerror=alert(1)></style>',
  },
];

/** 必须被完整保留（或按图片策略明确转换）的正常内容。 */
export const BENIGN_PAYLOADS: readonly XssPayload[] = [
  {
    name: 'heading-paragraph',
    html: '<h2>题目说明</h2><p>输出两数之和。</p>',
  },
  {
    name: 'katex-span',
    html: '<span class="katex"><span class="katex-html"><span class="mord">x</span></span></span>',
  },
  {
    name: 'highlight-code-block',
    html: '<pre class="hljs"><code>print(1)</code></pre>',
  },
  {
    name: 'table',
    html: '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
  },
  { name: 'ordered-list-start', html: '<ol start="3"><li>第三</li></ol>' },
  {
    name: 'anchor-https',
    html: '<a href="https://example.com" target="_blank" rel="noopener">链接</a>',
  },
  { name: 'site-relative-image', html: '<img src="/local.png" alt="站内">' },
];
