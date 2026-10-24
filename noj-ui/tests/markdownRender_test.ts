// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertStringIncludes } from 'jsr:@std/assert@^1';
import { renderMarkdownSync } from '../utils/markdownRender.ts';

Deno.test('共享 Markdown 渲染保留 KaTeX 样式且不在代码块中展开公式', () => {
  const html = renderMarkdownSync('$x^2$\n\n```python\nprint("$x$")\n```');
  assertStringIncludes(html, 'katex');
  assertStringIncludes(html, 'style=');
  assertStringIncludes(html, '$x$');
  assert(!html.includes('NOJKATEX'));
});

Deno.test('共享 Markdown 渲染阻止 HTML 和公式属性逃逸', () => {
  const html = renderMarkdownSync(
    '<img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)" title="$x$">link</a>',
  );
  assert(!html.includes('onerror'));
  assert(!html.includes('<script'));
  assert(!html.includes('javascript:'));
  assert(!html.includes('title="<'));
});

Deno.test('共享 Markdown 默认把外部图片转为链接，站内图片保留', () => {
  const html = renderMarkdownSync('![外部](https://example.test/a.png)\n\n![站内](/images/b.png)');
  assertStringIncludes(html, 'href="https://example.test/a.png"');
  assertStringIncludes(html, 'src="/images/b.png"');
  assert(!html.includes('src="https://example.test'));
});
