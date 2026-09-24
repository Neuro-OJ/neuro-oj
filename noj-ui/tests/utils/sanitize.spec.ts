/**
 * 净化器「未知标签降级」分支的 DOM 级回归测试。
 *
 * 背景：`simpleSanitize` 把非白名单标签降级为纯文本时，只转义了定界符
 * `<` / `>`，属性原文照抄。于是
 *
 *     <foo bar="<img src=x onerror=alert(1)//>">
 *
 * 被"净化"成 `&lt;foo bar="<img src=x onerror=alert(1)//&gt;">`，
 * 其中字面量 `<img ...>` 会被浏览器重新解析成**真标签**，onerror 可执行。
 * MarkdownRenderer 的 SSR 分支走 `sanitizeHtmlSync`，所以该载荷直接进入
 * 题目描述 / 社区帖子 / 公告 / 用户 bio 的首屏 HTML，无需任何交互。
 *
 * 单元断言（字符串层面查 `on*=`）会误报：转义后的文本里 ` onerror=` 仍在，
 * 但它已不是属性。因此这里用 happy-dom 真正解析后检查 DOM —— 只有解析结果
 * 才是浏览器看到的东西。
 */
import { describe, expect, it } from 'vitest';

import { sanitizeHtmlSync } from '~/utils/sanitize';

/** 把净化结果真正塞进 DOM，返回解析出的元素与内联事件处理器属性。 */
function parse(html: string): { host: HTMLElement; handlers: string[]; tags: string[] } {
  const host = document.createElement('div');
  host.innerHTML = html;

  const handlers: string[] = [];
  const tags: string[] = [];
  for (const el of Array.from(host.querySelectorAll('*'))) {
    tags.push(el.tagName.toLowerCase());
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        handlers.push(`${el.tagName.toLowerCase()}[${attr.name}=${attr.value}]`);
      }
    }
  }
  return { host, handlers, tags };
}

const PAYLOADS = [
  `<foo bar="<img src=x onerror=alert(1)//>">`,
  `<foo bar="<img src=x onerror=alert(document.domain)>">`,
  `<xyz a="<svg onload=alert(1)>">`,
  `<custom-el data-x="<iframe src=javascript:alert(1)></iframe>">`,
  `<foo bar="<img src=x onerror=window.__xss(777)//>">`,
];

describe('sanitize: 未知标签降级不得重新引入可解析标签', () => {
  it.each(PAYLOADS)('载荷 %s 解析后无内联事件处理器', (payload) => {
    const { handlers, tags } = parse(sanitizeHtmlSync(payload));
    expect(handlers).toEqual([]);
    // 载荷里的 img / svg / iframe 都不得成为真实元素
    expect(tags).not.toContain('img');
    expect(tags).not.toContain('svg');
    expect(tags).not.toContain('iframe');
  });

  it('降级文本仍然可读（实体化不吞内容）', () => {
    const { host } = parse(sanitizeHtmlSync(`<foo bar="a<b">hi</foo>`));
    expect(host.textContent).toContain('a<b');
    expect(host.textContent).toContain('hi');
  });
});

describe('sanitize: 白名单标签内的注入同样不可执行', () => {
  const WHITELISTED = [
    `<img src=x"onerror="alert(1)>`,
    `<img src=x"onerror=alert(1)>`,
    `<a href=x"onclick="alert(1)">click</a>`,
    `<div title=x"onmouseover="alert(1)">hover</div>`,
    `<img alt=">x" onerror=alert(1)>`,
  ];

  it.each(WHITELISTED)('载荷 %s 解析后无内联事件处理器', (payload) => {
    const { handlers } = parse(sanitizeHtmlSync(payload));
    expect(handlers).toEqual([]);
  });

  it('危险协议不残留为可导航的 href/src', () => {
    const { host } = parse(sanitizeHtmlSync(`<a href="javascript:alert(1)">x</a>`));
    const anchor = host.querySelector('a');
    expect(anchor?.getAttribute('href')).toBeNull();
  });
});
