/**
 * 净化器 DOM 级回归（服务端解析分支）。
 *
 * 背景（2026-11-02 rc/v0.11 审计 F1）：服务端分支原用正则重写 HTML 并手写实体解码，
 * 只识别带分号的数字实体，于是 `javascript&#58alert(1)` 通过协议检查、被浏览器解析成
 * `javascript:` URL —— SSR 首屏与降级路径存在点击触发的 XSS。
 *
 * 判据必须是**解析后的 DOM**：字符串级 `/\son[a-z]+=/` 会把属性值里的文本误判成
 * 事件处理器，只看字符串又会漏掉浏览器解析出的真标签。
 *
 * 覆盖分工（重要）：
 * - **服务端/SSR 分支**：本文件 + `tests/sanitize_test.ts`（Deno）。
 * - **客户端 DOMPurify 分支**：happy-dom 下 DOMPurify 会剥掉大量标签、并残留
 *   `svg > animate@onbegin` 之类的假象（happy-dom 自身解析缺陷，见
 *   `tests/components/ObjectiveRichText.spec.ts` 的既有注释），因此客户端分支**不**
 *   在这里断言，改由 `scripts/verify-bff-ssr.mjs` 在真实 Chromium 中验收
 *   （SSR 首屏 HTML、水合后 DOM、实际点击后 `window.__xss`）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sanitizeHtml from 'sanitize-html';

import { registerServerSanitizer, sanitizeHtmlSync } from '~/utils/sanitize';
import { BENIGN_PAYLOADS, XSS_PAYLOADS } from '../fixtures/xss-corpus';

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
]);

interface Parsed {
  handlers: string[];
  badUrls: string[];
  tags: string[];
}

/** 把净化结果真正塞进 DOM，检查处理器属性与可执行 URL。 */
function inspect(html: string): Parsed {
  const host = document.createElement('div');
  host.innerHTML = html;
  const handlers: string[] = [];
  const badUrls: string[] = [];
  const tags: string[] = [];
  for (const el of Array.from(host.querySelectorAll('*'))) {
    tags.push(el.tagName.toLowerCase());
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) handlers.push(`${el.tagName}[${name}]`);
      if (!URL_ATTRS.has(name)) continue;
      const value = attr.value.trim();
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
      if (!scheme) continue;
      if (!SAFE_SCHEMES.has(scheme)) {
        badUrls.push(`${el.tagName}[${name}=${value}]`);
      }
    }
  }
  return { handlers, badUrls, tags };
}

beforeAll(() => {
  // 生产由 Nitro 插件（server/plugins/rich-text-sanitizer.ts）注册；测试注册同一实现。
  registerServerSanitizer((html, options) => sanitizeHtml(html, options));
});

describe('sanitize(server): XSS 语料解析后不可执行', () => {
  it.each(XSS_PAYLOADS.map((p) => [p.name, p.html] as const))(
    '%s',
    (_name, html) => {
      const parsed = inspect(sanitizeHtmlSync(html));
      expect(parsed.handlers).toEqual([]);
      expect(parsed.badUrls).toEqual([]);
    },
  );
});

describe('sanitize(server): 图片策略', () => {
  it('站内相对路径保留为图片', () => {
    const host = document.createElement('div');
    host.innerHTML = sanitizeHtmlSync('<img src="/local.png" alt="站内">');
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/local.png');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('默认（不允许外链图片）时 https 外链降级为链接', () => {
    const host = document.createElement('div');
    host.innerHTML = sanitizeHtmlSync(
      '<img src="https://cdn.example/x.png" alt="图">',
    );
    expect(host.querySelector('img')).toBeNull();
    const anchor = host.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://cdn.example/x.png');
    expect(anchor?.getAttribute('rel')).toContain('noopener');
    expect(anchor?.textContent).toBe('图');
  });

  it('允许外链图片时保留 https 图片并加 referrerpolicy', () => {
    const host = document.createElement('div');
    host.innerHTML = sanitizeHtmlSync(
      '<img src="https://cdn.example/x.png" alt="图">',
      { allowExternalImages: true },
    );
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.example/x.png');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
});

describe('sanitize(server): 正常内容不被破坏', () => {
  it.each(BENIGN_PAYLOADS.map((p) => [p.name, p.html] as const))(
    '%s 的标签结构保留',
    (_name, html) => {
      const parsed = inspect(sanitizeHtmlSync(html));
      expect(parsed.handlers).toEqual([]);
      expect(parsed.badUrls).toEqual([]);
      expect(parsed.tags.length).toBeGreaterThan(0);
    },
  );
});
